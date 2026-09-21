import type {StoreApp} from "../../domain/catalog";
import {supabaseRequest} from "./client";

export async function loadSupabaseCatalog():Promise<StoreApp[]>{
 const r=await supabaseRequest("/rest/v1/applications?select=*,releases(*,artifacts(*))&order=name.asc");
 if(!r.ok) throw new Error(`Supabase catalog request failed: ${r.status}`);
 const rows=await r.json();
 return rows.map((a:any)=>{
  const releases=Array.isArray(a.releases)?a.releases:[];
  const latest=(channel:string)=>{
   const list=releases.filter((x:any)=>x.status==="published"&&x.channel===channel).sort((x:any,y:any)=>new Date(y.published_at||y.created_at).getTime()-new Date(x.published_at||x.created_at).getTime());
   const x=list[0]; if(!x)return undefined;
   return {id:String(x.id),applicationId:{provider:a.provider,project:a.project},version:{name:x.version_name,code:x.version_code??undefined},channel:x.channel,status:x.status,title:x.title,notes:x.notes,publishedAt:x.published_at,sourceReleaseId:x.source_release_id,artifacts:(x.artifacts||[]).map((z:any)=>({id:String(z.id),platform:z.platform,kind:z.kind,filename:z.filename,downloadUrl:z.download_url,sizeBytes:z.size_bytes,sha256:z.sha256,packageIdentity:z.package_identity,signingCertificateSha256:z.signing_certificate_sha256,versionCode:z.version_code}))};
  };
  return {id:{provider:a.provider,project:a.project},packageIdentity:a.package_identity,name:a.name,description:a.description,sourceUrl:a.source_url,iconUrl:a.icon_url,platforms:a.platforms??[],category:a.category??"Other",functionality:a.functionality??[],screenshots:a.screenshots??[],permissions:a.permissions??[],latest:{stable:latest("stable"),beta:latest("beta"),development:latest("development")}};
 });
}
