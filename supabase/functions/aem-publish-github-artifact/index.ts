import {createClient} from "npm:@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-github-token,x-aem-repo,x-aem-request-id,x-aem-run-id,x-aem-artifact-name,x-aem-app-name,x-aem-version-name,x-aem-version-code,x-aem-channel,x-aem-package,x-aem-filename,x-aem-title,x-aem-source-release-id,x-aem-signing-cert"};

function json(body:unknown,status=200){return Response.json(body,{status,headers:{...cors,"Content-Type":"application/json"}})}
function admin(){const raw=Deno.env.get("SUPABASE_SECRET_KEYS")||"{}";const keys=JSON.parse(raw);const key=keys.default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!key)throw new Error("Supabase server key unavailable");return createClient(Deno.env.get("SUPABASE_URL")!,key)}
function clean(v:string){return v.replace(/[^A-Za-z0-9._-]/g,"_")}

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 try{
  const ct=req.headers.get("content-type")||"";
  if(!ct.includes("application/json"))return json({error:"Direct APK upload is no longer used; call prepare then upload directly to Storage, then finalize."},410);
  const b=await req.json();
  const action=String(b.action||"");
  const repo=String(b.repo||"");
  const runId=Number(b.run_id||0);
  const filename=String(b.filename||"app-release.apk");
  const appName=String(b.application_name||"Application");
  const versionName=String(b.version_name||"unknown");
  const vc=Number(b.version_code);
  const versionCode=Number.isFinite(vc)?vc:null;
  const channel=["stable","beta","development"].includes(String(b.channel))?String(b.channel):"development";
  const packageIdentity=String(b.package_identity||"");
  const title=String(b.title||"AEM APK");
  const sourceReleaseId=String(b.source_release_id||`github-actions-${runId}`);
  const signingCertificateSha256=String(b.signing_certificate_sha256||"").trim().replace(/:/g,"").toLowerCase();
  if(!repo||!runId||versionCode===null||!packageIdentity)return json({error:"Missing required publish metadata."},400);
  const androidArtifactNeedsCentralSigning=true;

  const githubToken=(req.headers.get("x-github-token")||"").trim();
  if(!githubToken)return json({error:"GitHub authorization token is required for publishing."},401);
  const ghHeaders:Record<string,string>={"Accept":"application/vnd.github+json","Authorization":`Bearer ${githubToken}`,"X-GitHub-Api-Version":"2022-11-28"};
  const repoCheck=await fetch(`https://api.github.com/repos/${repo}`,{headers:ghHeaders});
  if(!repoCheck.ok)return json({error:"GitHub authorization could not verify the requested repository."},403);
  const repoInfo=await repoCheck.json();
  if(String(repoInfo?.owner?.login||"")!=="Emmanuel001afk")return json({error:"Publishing is restricted to repositories owned by Emmanuel001afk."},403);

  const sb=admin();
  const appRes=await sb.from("applications").select("id,package_identity").eq("provider","github").eq("project",repo).maybeSingle();
  if(appRes.error)throw appRes.error;
  if(!appRes.data)return json({error:`AEM application is not registered for ${repo}`},404);
  const appId=appRes.data.id;
  if(appRes.data.package_identity&&appRes.data.package_identity!==packageIdentity)return json({error:`APK package identity ${packageIdentity} does not match catalog package ${appRes.data.package_identity}`},409);

  const path=`${repo}/${clean(versionName)}/${clean(sourceReleaseId)}/${clean(filename)}`;
  const requestedObjectPath=String(b.object_path||b.path||path);
  if(requestedObjectPath!==path)return json({error:`Storage object path mismatch: expected ${path}, received ${requestedObjectPath}.`},409);

  if(action==="prepare"){
    if(!path||path.startsWith("/")||path.includes(".."))return json({error:"Invalid Storage object path"},400);
    const bucket=await sb.storage.getBucket("aem-artifacts");
    if(bucket.error)return json({error:`AEM Storage bucket is unavailable: ${bucket.error.message}`},502);
    if(!bucket.data)return json({error:"AEM Storage bucket aem-artifacts does not exist"},502);
    const up=await sb.storage.from("aem-artifacts").createSignedUploadUrl(path,{upsert:true});
    if(up.error)return json({error:`Storage signed-upload preparation failed: ${up.error.message}`},502);
    const uploadUrl=String(up.data?.signedUrl||"");
    const token=String(up.data?.token||"");
    if(!uploadUrl||!token)return json({error:"Storage did not return a valid signed upload URL"},502);
    return json({ok:true,path,storage_path:`aem-artifacts/${path}`,token,upload_url:uploadUrl,release_metadata:{repo,runId,filename,appName,versionName,versionCode,channel,packageIdentity,title,sourceReleaseId,signingCertificateSha256}});
  }

  if(action!=="finalize")return json({error:"Unknown action"},400);
  const existingRelease=await sb.from("releases").select("id,version_name,version_code,channel,status").eq("application_id",appId).eq("source_release_id",sourceReleaseId).maybeSingle();
  if(existingRelease.error)throw existingRelease.error;
  if(existingRelease.data){
    const existingArtifact=await sb.from("artifacts").select("id,download_url,size_bytes,sha256").eq("release_id",existingRelease.data.id).eq("filename",filename).maybeSingle();
    if(existingArtifact.error)throw existingArtifact.error;
    if(existingArtifact.data)return json({ok:true,duplicate:true,release_id:existingRelease.data.id,artifact_id:existingArtifact.data.id,download_url:existingArtifact.data.download_url,size_bytes:existingArtifact.data.size_bytes,sha256:existingArtifact.data.sha256});
  }
  const latest=await sb.from("releases").select("version_code").eq("application_id",appId).eq("channel",channel).eq("status","published").not("version_code","is",null).order("version_code",{ascending:false}).limit(1).maybeSingle();
  if(latest.error)throw latest.error;
  if(latest.data&&Number(versionCode)<=Number(latest.data.version_code||0))return json({error:`Refusing to publish version code ${versionCode}: latest published ${channel} version code is ${latest.data.version_code}.`},409);
  const sizeBytes=Number(b.size_bytes||0);
  const sha256=String(b.sha256||"").trim();
  if(sizeBytes<=0||!sha256)return json({error:"Missing uploaded artifact checksum/size"},400);

  const objectUrl=`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`;
  const head=await fetch(objectUrl,{method:"HEAD"});
  if(!head.ok)return json({error:`Uploaded APK was not found in AEM Storage (HTTP ${head.status}).`},409);
  const storedSize=Number(head.headers.get("content-length")||0);
  if(storedSize&&storedSize!==sizeBytes)return json({error:`Uploaded APK size mismatch: expected ${sizeBytes}, stored ${storedSize}.`},409);

  let release=existingRelease.data;
  if(!release){
    const created=await sb.from("releases").insert({application_id:appId,source_release_id:sourceReleaseId,version_name:versionName,version_code:versionCode,channel,status:"published",title,notes:null,published_at:new Date().toISOString()}).select("id").single();
    if(created.error)throw created.error;
    release=created.data;
  }
  const existing=await sb.from("artifacts").select("id,download_url").eq("release_id",release.id).eq("filename",filename).maybeSingle();
  if(existing.error)throw existing.error;
  if(existing.data)return json({ok:true,duplicate:true,release_id:release.id,artifact_id:existing.data.id,download_url:existing.data.download_url});

  const ins=await sb.from("artifacts").insert({release_id:release.id,platform:"android",kind:"apk",filename,download_url:objectUrl,size_bytes:sizeBytes,sha256,package_identity:packageIdentity,signing_certificate_sha256:null,signing_status:androidArtifactNeedsCentralSigning?"pending":"ready",signing_authority:"source",version_code:versionCode}).select("id").single();
  if(ins.error)throw ins.error;
  // The catalog name is source metadata; never replace it with the APK manifest label (which may be generic).
  await sb.from("applications").update({package_identity:packageIdentity,updated_at:new Date().toISOString()}).eq("id",appId);
  // Release history and release notifications are generated centrally by the database trigger.
  return json({ok:true,release_id:release.id,artifact_id:ins.data.id,download_url:objectUrl,sha256,size_bytes:sizeBytes});
 }catch(e){console.error("AEM publish error",e);return json({error:e instanceof Error?e.message:String(e)},500)}
});