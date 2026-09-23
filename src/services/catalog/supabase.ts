import type {StoreApp} from "../../domain/catalog";
import {supabaseRequest} from "../supabase/client";

export async function loadSupabaseCatalog():Promise<StoreApp[]>{
 const r=await supabaseRequest("/rest/v1/applications?select=*,releases!releases_application_id_fkey(*,artifacts!artifacts_release_id_fkey(*))&order=name.asc");
 if(!r.ok) throw new Error(`Supabase catalog request failed: ${r.status}`);
 const rows=await r.json();
 return rows.map((a:any)=>{
  const releases=Array.isArray(a.releases)?a.releases:[];
  const latest=(channel:string)=>{
   const list=releases.filter((x:any)=>{
    if(x.status!=="published"||x.channel!==channel)return false;
    if(String(x.version_name||"").startsWith("workflow-") && releases.some((r:any)=>r.status==="published"&&r.channel===channel&&!String(r.version_name||"").startsWith("workflow-"))) return false;
    return (x.artifacts||[]).some((z:any)=>z.platform==="android"&&["apk","apks","xapk","apkm"].includes(z.kind));
   }).sort((x:any,y:any)=>{
    const yc=Math.max(Number(y.version_code??0),...(y.artifacts||[]).map((z:any)=>Number(z.version_code??0)));
    const xc=Math.max(Number(x.version_code??0),...(x.artifacts||[]).map((z:any)=>Number(z.version_code??0)));
    if(yc!==xc)return yc-xc;
    return new Date(y.published_at||y.created_at).getTime()-new Date(x.published_at||x.created_at).getTime();
   });
   const x=list[0];if(!x)return undefined;
   return {id:String(x.id),applicationId:{provider:a.provider,project:a.project},version:{name:x.version_name,code:x.version_code??undefined},channel:x.channel,status:x.status,title:x.title,notes:x.notes,publishedAt:x.published_at,sourceReleaseId:x.source_release_id,artifacts:(x.artifacts||[]).map((z:any)=>({id:String(z.id),platform:z.platform,kind:z.kind,filename:z.filename,downloadUrl:z.download_url,sizeBytes:z.size_bytes,sha256:z.sha256,packageIdentity:z.package_identity,signingCertificateSha256:z.signing_certificate_sha256,versionCode:z.version_code}))};
  };
  return {databaseId:Number(a.id),id:{provider:a.provider,project:a.project},packageIdentity:a.package_identity||releases.flatMap((x:any)=>x.artifacts||[]).map((z:any)=>z.package_identity).find(Boolean),name:a.name,description:a.description,sourceUrl:a.source_url,iconUrl:a.icon_url,platforms:a.platforms??[],category:a.category??"Other",functionality:a.functionality??[],screenshots:a.screenshots??[],permissions:a.permissions??[],latest:{stable:latest("stable"),beta:latest("beta"),development:latest("development")}};
 });
}