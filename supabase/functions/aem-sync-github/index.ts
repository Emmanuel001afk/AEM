import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"POST,OPTIONS"};
const GH="https://api.github.com";
function out(x:any,s=200){return Response.json(x,{status:s,headers:{...cors,"Content-Type":"application/json"}})}
function db(){const k=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!k)throw Error("Supabase server key unavailable");return createClient(Deno.env.get("SUPABASE_URL")!,k)}
function kind(n:string){n=n.toLowerCase();return n.endsWith(".apk")?"apk":n.endsWith(".apks")?"apks":n.endsWith(".xapk")?"xapk":n.endsWith(".apkm")?"apkm":null}
function channel(t:string):"stable"|"beta"|"development"{t=t.toLowerCase();if(/(^|[-_.])(beta|b)([-_.]|\d|$)/.test(t))return"beta";if(/(^|[-_.])(dev|development|debug|nightly|alpha|canary)([-_.]|\d|$)/.test(t))return"development";return"stable"}
function displayName(repo:string){if(repo==="AEM")return"AEM Store";if(repo==="phormi-android")return"Phormi";if(repo==="lite-read")return"Lite Read";return repo}
async function gh(url:string,h:any){const r=await fetch(url,{headers:h});if(!r.ok)throw Error("GitHub API "+r.status);return r.json()}

async function unzipEntry(buf:Uint8Array,wanted:string){
 const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
 const u16=(p:number)=>dv.getUint16(p,true),u32=(p:number)=>dv.getUint32(p,true);
 const e=Math.min(buf.length-22,buf.length-65558);
 for(let p=buf.length-22;p>=e;p--){
  if(u32(p)!==0x06054b50)continue;
  const n=u16(p+10),off=u32(p+16); let q=off;
  for(let i=0;i<n&&q+46<=buf.length;i++){
   if(u32(q)!==0x02014b50)break;
   const method=u16(q+10),cs=u32(q+20),us=u32(q+24),nl=u16(q+28),xl=u16(q+30),cl=u16(q+32),lo=u32(q+42);
   const name=new TextDecoder().decode(buf.slice(q+46,q+46+nl));
   q+=46+nl+xl+cl;
   if(name!==wanted)continue;
   const ln=u16(lo+26),lx=u16(lo+28),raw=buf.slice(lo+30+ln+lx,lo+30+ln+lx+cs);
   if(method===0)return raw;
   if(method===8)return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
   return null;
  }
 }
 return null;
}
async function apkMetadata(buf:Uint8Array){
 const manifest=await unzipEntry(buf,"AndroidManifest.xml");
 return manifest?parseApkManifest(manifest):{};
}
async function zipApks(buf:Uint8Array){
 const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
 const u16=(p:number)=>dv.getUint16(p,true),u32=(p:number)=>dv.getUint32(p,true);
 const e=Math.min(buf.length-22,buf.length-65558);
 for(let p=buf.length-22;p>=e;p--){
  if(u32(p)!==0x06054b50)continue;
  const n=u16(p+10),off=u32(p+16),out:any[]=[];let q=off;
  for(let i=0;i<n&&q+46<=buf.length;i++){
   if(u32(q)!==0x02014b50)break;
   const method=u16(q+10),cs=u32(q+20),us=u32(q+24),nl=u16(q+28),xl=u16(q+30),cl=u16(q+32),lo=u32(q+42);
   const name=new TextDecoder().decode(buf.slice(q+46,q+46+nl));
   q+=46+nl+xl+cl;
   if(!/\.(apk|apks|xapk|apkm)$/i.test(name)||us>80*1024*1024)continue;
   const ln=u16(lo+26),lx=u16(lo+28),raw=buf.slice(lo+30+ln+lx,lo+30+ln+lx+cs);
   let bytes=raw;
   if(method===8)bytes=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
   if(method!==0&&method!==8)continue;
   if(bytes.length){
    const meta=kind(name)==="apk"?await apkMetadata(bytes):{};
    out.push({name:name.split("/").pop()||"application.apk",bytes,packageName:meta.packageName,versionCode:meta.versionCode,versionName:meta.versionName});
   }
  }
  return out;
 }
 return [];
}
function readU16(v:DataView,p:number){return v.getUint16(p,true)}
function readU32(v:DataView,p:number){return v.getUint32(p,true)}
function readLen8(b:Uint8Array,p:number){let n=0,shift=0,x=0;do{x=b[p++];n|=(x&127)<<shift;shift+=7}while(x&128);return [n,p] as const}
function readLen16(v:DataView,p:number){const first=readU16(v,p);if(first&0x8000)return [((first&0x7fff)<<16)|readU16(v,p+2),p+4] as const;return [first,p+2] as const}
function axmlStrings(buf:Uint8Array,v:DataView,off:number){
 if(readU16(v,off)!==1)return null;
 const count=readU32(v,off+8),flags=readU32(v,off+16),start=readU32(v,off+20),utf8=(flags&0x100)!==0,base=off+start;
 const offs=Array.from({length:count},(_,i)=>readU32(v,off+28+i*4));
 return (idx:number)=>{if(idx<0||idx>=offs.length)return "";let p=base+offs[idx];
  if(utf8){const a=readLen8(buf,p),b=readLen8(buf,a[1]);return new TextDecoder().decode(buf.slice(b[1],b[1]+a[0]))}
  const a=readLen16(v,p);return new TextDecoder("utf-16le").decode(buf.slice(a[1],a[1]+a[0]*2))}
}
function parseApkManifest(buf:Uint8Array){
 try{
  const v=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  if(buf.length<8||readU16(v,0)!==3)return {};
  let p=8,strings:any=null,packageName="",versionCode:number|undefined,versionName:string|undefined;
  while(p+8<=buf.length){
   const type=readU16(v,p),size=readU32(v,p+4);if(size<8||p+size>buf.length)break;
   if(type===1)strings=axmlStrings(buf,v,p);
   else if(type===0x102&&strings&&p+36<=buf.length){
    const attrStart=readU16(v,p+24),attrSize=readU16(v,p+26),attrCount=readU16(v,p+28),attrs=p+16+attrStart;
    for(let i=0;i<attrCount;i++){
     const q=attrs+i*attrSize;if(q+20>p+size)break;
     const name=strings(readU32(v,q+4)),raw=readU32(v,q+8),dataType=buf[q+15],data=readU32(v,q+16),value=raw===0xffffffff?"":strings(raw);
     if(name==="package")packageName=value||packageName;
     if(name==="versionName")versionName=value;
     if(name==="versionCode")versionCode=dataType===0x10||dataType===0x11?data:Number(value);
    }
   }
   p+=size;
  }
  return {packageName,versionCode,versionName};
 }catch{return {}}
}
async function hash(b:Uint8Array){const d=await crypto.subtle.digest("SHA-256",b);return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,"0")).join("")}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors}); if(req.method!=="POST")return out({error:"POST required"},405);
 const sb=db(), started=new Date();
 try{
  const callerSecret=(req.headers.get("x-aem-sync-secret")||"").trim();
  const secretResult=await sb.rpc("aem_get_sync_secret");
  if(secretResult.error||!secretResult.data||callerSecret!==String(secretResult.data))return out({ok:false,error:"Unauthorized sync caller."},401);
  const token=(Deno.env.get("AEM_GITHUB_TOKEN")||Deno.env.get("GITHUB_TOKEN")||"").trim();
  if(!token){
   const message="AEM_GITHUB_TOKEN is not configured in Supabase Edge Function secrets.";
   await sb.from("source_sync_state").upsert({provider:"github",status:"failed",last_started_at:started.toISOString(),last_error:message,updated_at:started.toISOString()},{onConflict:"provider"});
   return out({ok:false,error:message,code:"GITHUB_TOKEN_MISSING"},503);
  }
  const h={"Accept":"application/vnd.github+json","Authorization":"Bearer "+token,"X-GitHub-Api-Version":"2026-03-10"};
  const me=await gh(GH+"/user",h); if(String(me.login)!=="Emmanuel001afk")return out({error:"GitHub token is not for Emmanuel001afk."},403);
  const st=(await sb.from("source_sync_state").select("status,last_started_at,last_success_at").eq("provider","github").maybeSingle()).data;
  const now=Date.now(), ls=st?.last_success_at?Date.parse(st.last_success_at):0, lt=st?.last_started_at?Date.parse(st.last_started_at):0;
  if(st?.status==="running"&&now-lt<300000)return out({ok:true,throttled:true});
  if(ls&&now-ls<30000)return out({ok:true,throttled:true,last_success_at:st.last_success_at});
  await sb.from("source_sync_state").upsert({provider:"github",status:"running",last_started_at:started.toISOString(),last_error:null,updated_at:started.toISOString()},{onConflict:"provider"});
  const repos:any[]=[]; for(let p=1;;p++){const rows=await gh(GH+`/user/repos?visibility=all&affiliation=owner&per_page=100&page=${p}`,h);if(!rows.length)break;repos.push(...rows);if(rows.length<100)break}
  let apps=0,releases=0,artifacts=0,failedRepos=0;
  for(const repo of repos){try{
   const tree=await gh(GH+`/repos/${repo.full_name}/git/trees/${repo.default_branch||"main"}?recursive=1`,h).catch(()=>({tree:[]}));
   const files=(tree.tree||[]).filter((x:any)=>x.type==="blob"&&kind(String(x.path)));
   const rr=await gh(GH+`/repos/${repo.full_name}/releases?per_page=50`,h).catch(()=>[]);
   const rels=Array.isArray(rr)?rr.filter((r:any)=>!r.draft&&(r.assets||[]).some((a:any)=>kind(a.name))):[];
   const runProbe=await gh(GH+`/repos/${repo.full_name}/actions/runs?status=success&per_page=5`,h).catch(()=>({workflow_runs:[]}));
   let workflowApk=false;
   for(const probe of (runProbe.workflow_runs||[])){const pa=await gh(GH+`/repos/${repo.full_name}/actions/runs/${probe.id}/artifacts?per_page=50&direction=desc`,h).catch(()=>({artifacts:[]}));if((pa.artifacts||[]).some((x:any)=>!x.expired&&/(apk|android|build|release)/i.test(String(x.name||"")))){workflowApk=true;break}}
   if(!files.length&&!rels.length&&!workflowApk)continue;
   let a=(await sb.from("applications").select("id,name,package_identity,description_source,icon_source").eq("provider","github").eq("project",repo.full_name).maybeSingle()).data;
   const patch:any={provider:"github",project:repo.full_name,source_external_id:String(repo.id),source_visibility:repo.private?"private":"public",name:(a?.name&&a.name!=="Application")?a.name:displayName(String(repo.name)),description:repo.description||null,description_source:"github",source_url:repo.html_url,icon_url:repo.owner?.avatar_url||null,icon_source:"github-avatar",platforms:["android"],updated_at:new Date().toISOString()};
   if(a?.description_source==="manual"){delete patch.description;delete patch.description_source} if(a?.icon_source==="manual"){delete patch.icon_url;delete patch.icon_source}
   if(!a){a=(await sb.from("applications").insert(patch).select("id,package_identity").single()).data;apps++}else a=(await sb.from("applications").update(patch).eq("id",a.id).select("id,package_identity").single()).data;
   for(const r of rels){const sid=`github-release-${r.id}`;let rel=(await sb.from("releases").select("id").eq("application_id",a.id).eq("source_release_id",sid).maybeSingle()).data;if(!rel){rel=(await sb.from("releases").insert({application_id:a.id,source_release_id:sid,version_name:String(r.tag_name||r.name||"unknown"),channel:channel(String(r.tag_name||r.name||"")),status:"published",title:r.name||r.tag_name||"GitHub release",notes:r.body||null,published_at:r.published_at||r.created_at}).select("id").single()).data;releases++}for(const asset of (r.assets||[]).filter((x:any)=>kind(x.name))){const f=await fetch(asset.browser_download_url,{headers:h});if(!f.ok)continue;const b=new Uint8Array(await f.arrayBuffer()),k=kind(asset.name),meta=k==="apk"?await apkMetadata(b):{},path=`${repo.full_name}/${String(r.tag_name||r.id).replace(/[^A-Za-z0-9._-]/g,"_")}/${String(asset.name).replace(/[^A-Za-z0-9._-]/g,"_")}`;const up=await sb.storage.from("aem-artifacts").upload(path,b,{contentType:k==="apk"?"application/vnd.android.package-archive":"application/octet-stream",upsert:true});if(up.error)throw up.error;const sha=await hash(b);const existing=(await sb.from("artifacts").select("id").eq("release_id",rel.id).eq("filename",asset.name).maybeSingle()).data;const payload={release_id:rel.id,platform:"android",kind:k,filename:asset.name,download_url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`,size_bytes:b.byteLength,sha256:sha,package_identity:meta.packageName||a.package_identity||null,version_code:meta.versionCode??null};const ins=existing?await sb.from("artifacts").update(payload).eq("id",existing.id):await sb.from("artifacts").insert(payload);if(!ins.error){artifacts++;if(meta.packageName&&!a.package_identity){a.package_identity=meta.packageName;await sb.from("applications").update({package_identity:meta.packageName,updated_at:new Date().toISOString()}).eq("id",a.id)}}}}
   for(const f of files){const sid=`github-file-${f.sha}`;if((await sb.from("releases").select("id").eq("application_id",a.id).eq("source_release_id",sid).maybeSingle()).data)continue;const raw=`https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch||"main"}/${String(f.path).split("/").map(encodeURIComponent).join("/")}`;const x=await fetch(raw,{headers:h});if(!x.ok)continue;const b=new Uint8Array(await x.arrayBuffer()),k=kind(String(f.path)),meta=k==="apk"?await apkMetadata(b):{},rel=(await sb.from("releases").insert({application_id:a.id,source_release_id:sid,version_name:meta.versionName||"Repository APK",version_code:meta.versionCode??null,channel:"development",status:"published",title:String(f.path),published_at:new Date().toISOString()}).select("id").single()).data,path=`${repo.full_name}/source/${f.sha}/${String(f.path).split("/").pop()}`;const up=await sb.storage.from("aem-artifacts").upload(path,b,{contentType:k==="apk"?"application/vnd.android.package-archive":"application/octet-stream",upsert:true});if(up.error)throw up.error;const ins=await sb.from("artifacts").insert({release_id:rel.id,platform:"android",kind:k,filename:String(f.path).split("/").pop(),download_url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`,size_bytes:b.byteLength,sha256:await hash(b),package_identity:meta.packageName||a.package_identity||null,version_code:meta.versionCode??null});if(!ins.error){releases++;artifacts++;if(meta.packageName&&!a.package_identity)await sb.from("applications").update({package_identity:meta.packageName,updated_at:new Date().toISOString()}).eq("id",a.id)}}

   const runs=await gh(GH+`/repos/${repo.full_name}/actions/runs?status=success&per_page=10`,h).catch(()=>({workflow_runs:[]}));
   for(const run of (runs.workflow_runs||[])){
    const ar=await gh(GH+`/repos/${repo.full_name}/actions/runs/${run.id}/artifacts?per_page=50&direction=desc`,h).catch(()=>({artifacts:[]}));
    for(const wa of (ar.artifacts||[])){
     if(wa.expired||!/(apk|android|build|release)/i.test(String(wa.name||"")))continue;
     const sid=`github-actions-artifact-${wa.id}`;if((await sb.from("releases").select("id").eq("application_id",a.id).eq("source_release_id",sid).maybeSingle()).data)continue;
     const z=await fetch(wa.archive_download_url,{headers:h});if(!z.ok)continue;const entries=await zipApks(new Uint8Array(await z.arrayBuffer()));if(!entries.length)continue;
     const versioned=entries.filter((x:any)=>Number.isFinite(Number(x.versionCode))&&Number(x.versionCode)>0).sort((x:any,y:any)=>Number(y.versionCode)-Number(x.versionCode));const primary=versioned[0]||entries[0];const realCode=primary?.versionCode!=null?Number(primary.versionCode):null;const realName=primary?.versionName?String(primary.versionName):`workflow-${run.run_number||run.id}`;const pkg=primary?.packageName?String(primary.packageName):a.package_identity||null;const releaseChannel=channel(String(wa.name||run.name||""));const sourceRelease=(await sb.from("releases").select("id,version_code,source_release_id").eq("application_id",a.id).eq("source_release_id",sid).maybeSingle()).data;const sameVersion=realCode!=null?(await sb.from("releases").select("id,version_code,source_release_id").eq("application_id",a.id).eq("channel",releaseChannel).eq("status","published").eq("version_code",realCode).limit(1).maybeSingle()).data:null;const existingRelease=sourceRelease||sameVersion;const reusedExisting=!sourceRelease&&!!sameVersion;const rr=existingRelease?{data:existingRelease,error:null}:await sb.from("releases").insert({application_id:a.id,source_release_id:sid,version_name:realName,version_code:realCode,channel:releaseChannel,status:"published",title:String(wa.name||"GitHub Actions APK"),notes:`APK discovered from GitHub Actions workflow run ${run.id}.`,published_at:run.updated_at||run.created_at}).select("id").single();if(rr.error)throw rr.error;if(sourceRelease)await sb.from("releases").update({version_name:realName,version_code:realCode,channel:releaseChannel,title:String(wa.name||"GitHub Actions APK"),published_at:run.updated_at||run.created_at}).eq("id",sourceRelease.id);let made=0;
     for(const ent of entries){const path=`${repo.full_name}/actions/${wa.id}/${ent.name}`,up=await sb.storage.from("aem-artifacts").upload(path,ent.bytes,{contentType:"application/vnd.android.package-archive",upsert:true});if(up.error)throw up.error;const sha=await hash(ent.bytes);const existingArtifact=(await sb.from("artifacts").select("id").eq("release_id",rr.data.id).eq("filename",ent.name).maybeSingle()).data;const payload={release_id:rr.data.id,platform:"android",kind:kind(ent.name),filename:ent.name,download_url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`,size_bytes:ent.bytes.byteLength,sha256:sha,package_identity:ent.packageName||a.package_identity||null,version_code:ent.versionCode??null};const ins=existingArtifact?await sb.from("artifacts").update(payload).eq("id",existingArtifact.id):await sb.from("artifacts").insert(payload);if(!ins.error){artifacts++;made++;if(ent.packageName&&!a.package_identity){a.package_identity=ent.packageName;await sb.from("applications").update({package_identity:ent.packageName,updated_at:new Date().toISOString()}).eq("id",a.id)}}}
     if(made){if(!existingRelease)releases++}else if(!existingRelease){await sb.from("releases").delete().eq("id",rr.data.id)}
    }
   }
  }catch(e){failedRepos++;console.error("repo sync",repo.full_name,e)}}
  const finished=new Date().toISOString(), partial=failedRepos>0, syncError=partial?(`${failedRepos} repository sync(s) failed; see Edge Function logs for details.`):null;
  await sb.from("source_sync_state").upsert({provider:"github",status:partial?"partial":"success",last_started_at:started.toISOString(),last_success_at:finished,last_error:syncError,repositories_scanned:repos.length,applications_discovered:apps,releases_discovered:releases,artifacts_discovered:artifacts,updated_at:finished},{onConflict:"provider"});
  return out({ok:true,partial,provider:"github",authenticated_as:me.login,scanned:repos.length,failed_repositories:failedRepos,discovered:apps,releases,artifacts});
 }catch(e){const m=e instanceof Error?e.message:String(e);await sb.from("source_sync_state").upsert({provider:"github",status:"failed",last_error:m,updated_at:new Date().toISOString()},{onConflict:"provider"});return out({error:m},500)}
});