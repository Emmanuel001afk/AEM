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
  const signingCertificateSha256=String(b.signing_certificate_sha256||"").trim();
  if(!repo||!runId||versionCode===null||!packageIdentity)return json({error:"Missing required publish metadata"},400);

  const githubToken=(req.headers.get("x-github-token")||"").trim();
  const ghHeaders:Record<string,string>={"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  if(githubToken)ghHeaders.Authorization=`Bearer ${githubToken}`;
  let repoCheck=await fetch(`https://api.github.com/repos/${repo}`,{headers:ghHeaders});
  if(!repoCheck.ok&&githubToken)repoCheck=await fetch(`https://api.github.com/repos/${repo}`,{headers:{"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});
  if(!repoCheck.ok)return json({error:"Requested GitHub repository could not be verified."},403);

  const sb=admin();
  const appRes=await sb.from("applications").select("id,package_identity").eq("provider","github").eq("project",repo).maybeSingle();
  if(appRes.error)throw appRes.error;
  if(!appRes.data)return json({error:`AEM application is not registered for ${repo}`},404);
  const appId=appRes.data.id;
  const requestId=String(req.headers.get("x-aem-request-id")||"").trim();
  const requestRunId=Number(req.headers.get("x-aem-run-id")||runId);
  if(requestId){
    const request=await sb.from("build_requests").select("id,repository,workflow_run_id,status").eq("id",requestId).maybeSingle();
    if(request.error)throw request.error;
    if(!request.data)return json({error:"Build request not found"},404);
    if(request.data.repository!==repo)return json({error:"Build request repository mismatch"},403);
    if(Number(request.data.workflow_run_id||0)!==requestRunId)return json({error:"Build request workflow mismatch"},403);
  }
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
  const latest=await sb.from("releases").select("version_code").eq("application_id",appId).eq("channel",channel).eq("status","published").order("version_code",{ascending:false}).limit(1).maybeSingle();
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

  const ins=await sb.from("artifacts").insert({release_id:release.id,platform:"android",kind:"apk",filename,download_url:objectUrl,size_bytes:sizeBytes,sha256,package_identity:packageIdentity,signing_certificate_sha256:signingCertificateSha256||null,version_code:versionCode}).select("id").single();
  if(ins.error)throw ins.error;
  await sb.from("applications").update({name:appName,package_identity:packageIdentity,updated_at:new Date().toISOString()}).eq("id",appId);
  try {
    const historyResult=await sb.from("release_history").insert({application_id:appId,release_id:release.id,reason:"published"});
    if(historyResult.error) console.error("Release history insert failed:",historyResult.error);
  } catch(error) {
    console.error("Unexpected release history insert error:",error);
  }
  try {
    const notificationResult=await sb.from("notifications").insert({kind:"release",title:`New ${appName} release`,body:`${versionName} is now available in AEM Store.`,app_id:appId,release_id:release.id});
    if(notificationResult.error) console.error("Notification insert failed:",notificationResult.error);
  } catch(error) {
    console.error("Unexpected notification insert error:",error);
  }
  if(requestId){
    const now=new Date().toISOString();
    const updated=await sb.from("build_requests").update({status:"succeeded",release_id:release.id,artifact_id:ins.data.id,error:null,updated_at:now}).eq("id",requestId).eq("status","running").select("id").maybeSingle();
    if(updated.error)throw updated.error;
    await sb.from("manager_state").upsert({id:"default",last_run_at:now,last_success_at:now,status:"idle",active_operations:0,updated_at:now},{onConflict:"id"});
  }
  return json({ok:true,release_id:release.id,artifact_id:ins.data.id,download_url:objectUrl,sha256,size_bytes:sizeBytes});
 }catch(e){console.error("AEM publish error",e);return json({error:e instanceof Error?e.message:String(e)},500)}
});