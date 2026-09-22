import {createClient} from "npm:@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-github-token,x-aem-repo,x-aem-request-id,x-aem-run-id,x-aem-artifact-name,x-aem-app-name,x-aem-version-name,x-aem-version-code,x-aem-channel,x-aem-package,x-aem-filename,x-aem-title,x-aem-source-release-id,x-aem-signing-cert"};

function json(body:unknown,status=200){return Response.json(body,{status,headers:{...cors,"Content-Type":"application/json"}})}
function admin(){const raw=Deno.env.get("SUPABASE_SECRET_KEYS")||"{}";const keys=JSON.parse(raw);const key=keys.default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!key)throw new Error("Supabase server key unavailable");return createClient(Deno.env.get("SUPABASE_URL")!,key)}
function clean(v:string){return v.replace(/[^A-Za-z0-9._-]/g,"_")}

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 try{
  const ct=req.headers.get("content-type")||"";
  let bytes:Uint8Array,repo:string,requestId:string,runId:number,filename:string,appName:string,versionName:string,versionCode:number|null,channel:string,packageIdentity:string,title:string,sourceReleaseId:string,signingCertificateSha256:string;
  if(!ct.includes("application/json")){
   repo=req.headers.get("x-aem-repo")||"";
   requestId=req.headers.get("x-aem-request-id")||"";
   runId=Number(req.headers.get("x-aem-run-id")||0);
   filename=req.headers.get("x-aem-filename")||"app.apk";
   appName=req.headers.get("x-aem-app-name")||repo.split("/").pop()||"Application";
   versionName=req.headers.get("x-aem-version-name")||"unknown";
   const vc=Number(req.headers.get("x-aem-version-code")||"");
   versionCode=Number.isFinite(vc)?vc:null;
   channel=["stable","beta","development"].includes(req.headers.get("x-aem-channel")||"")?req.headers.get("x-aem-channel")!:"development";
   packageIdentity=req.headers.get("x-aem-package")||"";
   title=req.headers.get("x-aem-title")||"AEM APK";
   sourceReleaseId=req.headers.get("x-aem-source-release-id")||`github-actions-${runId}`;
   signingCertificateSha256=(req.headers.get("x-aem-signing-cert")||"").trim();
   bytes=new Uint8Array(await req.arrayBuffer());
  }else{
   const b=await req.json();repo=String(b.repo||"");requestId=String(b.request_id||"");runId=Number(b.run_id||0);filename=String(b.filename||"app.apk");appName=String(b.application_name||"Application");versionName=String(b.version_name||"unknown");const vc=Number(b.version_code);versionCode=Number.isFinite(vc)?vc:null;channel=["stable","beta","development"].includes(String(b.channel))?String(b.channel):"development";packageIdentity=String(b.package_identity||"");title=String(b.title||"AEM APK");sourceReleaseId=String(b.source_release_id||`github-actions-${runId}`);signingCertificateSha256=String(b.signing_certificate_sha256||"").trim();if(!repo||!runId)return json({error:"Missing publish metadata"},400);const token=req.headers.get("x-github-token");if(!token)return json({error:"Missing GitHub credential"},401);return json({error:"JSON artifact publishing is disabled; send the APK bytes directly."},415);
  }
  if(!repo||!bytes?.length)return json({error:"Missing APK payload"},400);
  const githubToken=(req.headers.get("x-github-token")||"").trim();
  if(!githubToken)return json({error:"GitHub credential is required for artifact publishing."},401);
  const ghHeaders={"Accept":"application/vnd.github+json","Authorization":`Bearer ${githubToken}`,"X-GitHub-Api-Version":"2022-11-28"};
  const repoCheck=await fetch(`https://api.github.com/repos/${repo}`,{headers:ghHeaders});
  if(!repoCheck.ok)return json({error:"GitHub credential cannot access the requested repository."},403);
  if(!packageIdentity)return json({error:"APK package identity is required; refusing to publish unvalidated Android artifact."},400);
  if(versionCode===null||versionCode<0)return json({error:"APK version code is required; refusing to publish unvalidated Android artifact."},400);
  const sb=admin();
  const appRes=await sb.from("applications").select("id").eq("provider","github").eq("project",repo).maybeSingle();
  if(appRes.error)throw appRes.error;
  if(!appRes.data)return json({error:`AEM application is not registered for ${repo}`},404);
  const appId=appRes.data.id;
  const existingApp=await sb.from("applications").select("package_identity").eq("id",appId).single();
  if(existingApp.error)throw existingApp.error;
  if(existingApp.data.package_identity && existingApp.data.package_identity!==packageIdentity)return json({error:`APK package identity ${packageIdentity} does not match catalog package ${existingApp.data.package_identity}`},409);
  const appPatch:any={name:appName,updated_at:new Date().toISOString()};
  if(packageIdentity)appPatch.package_identity=packageIdentity;
  const appUpdate=await sb.from("applications").update(appPatch).eq("id",appId);
  if(appUpdate.error)throw appUpdate.error;

  let release=(await sb.from("releases").select("id").eq("application_id",appId).eq("source_release_id",sourceReleaseId).maybeSingle()).data;
  if(!release){
   const created=await sb.from("releases").insert({application_id:appId,source_release_id:sourceReleaseId,version_name:versionName,version_code:versionCode,channel,status:"published",title,notes:null,published_at:new Date().toISOString()}).select("id").single();
   if(created.error)throw created.error;release=created.data;
  }
  const existing=await sb.from("artifacts").select("id,download_url").eq("release_id",release.id).eq("filename",filename).maybeSingle();
  if(existing.error)throw existing.error;
  if(existing.data){
   if(requestId)await sb.from("build_requests").update({status:"succeeded",workflow_run_id:runId,application_id:appId,release_id:release.id,artifact_id:existing.data.id,error:null,updated_at:new Date().toISOString()}).eq("id",requestId);
   return json({ok:true,duplicate:true,release_id:release.id,artifact_id:existing.data.id,download_url:existing.data.download_url});
  }

  const digest=await crypto.subtle.digest("SHA-256",bytes);
  const sha=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
  const path=`${repo}/${clean(versionName)}/${clean(sourceReleaseId)}/${clean(filename)}`;
  const up=await sb.storage.from("aem-artifacts").upload(path,bytes,{contentType:filename.toLowerCase().endsWith(".apk")?"application/vnd.android.package-archive":"application/octet-stream",upsert:true});
  if(up.error)throw up.error;
  const url=`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`;
  const ins=await sb.from("artifacts").insert({release_id:release.id,platform:"android",kind:filename.toLowerCase().endsWith(".apks")?"apks":filename.toLowerCase().endsWith(".xapk")?"xapk":filename.toLowerCase().endsWith(".apkm")?"apkm":"apk",filename,download_url:url,size_bytes:bytes.byteLength,sha256:sha,package_identity:packageIdentity||null,signing_certificate_sha256:signingCertificateSha256||null,version_code:versionCode}).select("id").single();
  if(ins.error)throw ins.error;
  if(requestId)await sb.from("build_requests").update({status:"succeeded",workflow_run_id:runId,application_id:appId,release_id:release.id,artifact_id:ins.data.id,error:null,updated_at:new Date().toISOString()}).eq("id",requestId);
  await sb.from("release_history").insert({application_id:appId,release_id:release.id,reason:"published"}).catch(()=>{});
  await sb.from("notifications").insert({kind:"release",title:`New ${appName} release`,body:`${versionName} is now available in AEM Store.`,app_id:appId,release_id:release.id}).catch(()=>{});
  return json({ok:true,release_id:release.id,artifact_id:ins.data.id,download_url:url,sha256:sha,size_bytes:bytes.byteLength});
 }catch(e){return json({error:e instanceof Error?e.message:String(e)},500)}
});