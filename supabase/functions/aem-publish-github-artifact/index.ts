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
  if(appRes.data.package_identity&&appRes.data.package_identity!==packageIdentity)return json({error:`APK package identity ${packageIdentity} does not match catalog package ${appRes.data.package_identity}`},409);

  const latest=await sb.from("releases").select("version_code").eq("application_id",appId).eq("channel",channel).eq("status","published").order("version_code",{ascending:false}).limit(1).maybeSingle();
  if(latest.error)throw latest.error;
  if(latest.data&&Number(versionCode)<=Number(latest.data.version_code||0))return json({error:`Refusing to publish version code ${versionCode}: latest published ${channel} version code is ${latest.data.version_code}.`},409);

  const path=`${repo}/${clean(versionName)}/${clean(sourceReleaseId)}/${clean(filename)}`;

  if(action==="prepare"){
    const up=await sb.storage.from("aem-artifacts").createSignedUploadUrl(path,{upsert:true});
    if(up.error)return json({error:`Storage signed-upload preparation failed: ${up.error.message}`},502);
    return json({ok:true,path,token:up.data.token,upload_url:up.data.signedUrl,release_metadata:{repo,runId,filename,appName,versionName,versionCode,channel,packageIdentity,title,sourceReleaseId,signingCertificateSha256}});
  }

  if(action!=="finalize")return json({error:"Unknown action"},400);
  const sizeBytes=Number(b.size_bytes||0);
  const sha256=String(b.sha256||"").trim();
  if(sizeBytes<=0||!sha256)return json({error:"Missing uploaded artifact checksum/size"},400);

  const objectUrl=`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`;
  const head=await fetch(objectUrl,{method:"HEAD"});
  if(!head.ok)return json({error:`Uploaded APK was not found in AEM Storage (HTTP ${head.status}).`},409);
  const storedSize=Number(head.headers.get("content-length")||0);
  if(storedSize&&storedSize!==sizeBytes)return json({error:`Uploaded APK size mismatch: expected ${sizeBytes}, stored ${storedSize}.`},409);

  let release=(await sb.from("releases").select("id").eq("application_id",appId).eq("source_release_id",sourceReleaseId).maybeSingle()).data;
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
  await sb.from("release_history").insert({application_id:appId,release_id:release.id,reason:"published"}).catch(()=>{});
  await sb.from("notifications").insert({kind:"release",title:`New ${appName} release`,body:`${versionName} is now available in AEM Store.`,app_id:appId,release_id:release.id}).catch(()=>{});
  return json({ok:true,release_id:release.id,artifact_id:ins.data.id,download_url:objectUrl,sha256,size_bytes:sizeBytes});
 }catch(e){console.error("AEM publish error",e);return json({error:e instanceof Error?e.message:String(e)},500)}
});