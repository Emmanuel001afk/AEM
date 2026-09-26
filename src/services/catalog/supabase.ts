import type {StoreApp} from "../../domain/catalog";
import {supabaseRequest} from "../supabase/client";

export async function loadSupabaseCatalog():Promise<StoreApp[]>{
 const r=await supabaseRequest("/rest/v1/applications?select=*,releases!releases_application_id_fkey(*,artifacts!artifacts_release_id_fkey(*))&order=name.asc",{cache:"no-store",headers:{"Cache-Control":"no-cache"}});
 if(!r.ok) throw new Error(`Supabase catalog request failed: ${r.status}`);
 const rows=await r.json();
 return rows.map((a:any)=>{
  const releases=Array.isArray(a.releases)?a.releases.map((x:any)=>({...x,artifacts:Array.isArray(x.artifacts)?x.artifacts:[]})).filter((x:any)=>x.status==="published"):[];
  // The actionable catalog release must have a ready Android artifact.
  // A newer published release with signing_status=pending/processing must not
  // block installation/update from the newest already-ready APK.
  const latestRelease=(()=>{
   const list=releases.filter((x:any)=>{
    if(x.status!=="published")return false;
    return (x.artifacts||[]).some((z:any)=>z.platform==="android"&&
      ["apk","apks","xapk","apkm"].includes(String(z.kind||"").toLowerCase()) &&
      (z.signing_status??z.signingStatus)==="ready");
   }).sort((x:any,y:any)=>{
    const yc=Math.max(Number(y.version_code??0),...(y.artifacts||[]).map((z:any)=>Number(z.version_code??0)));
    const xc=Math.max(Number(x.version_code??0),...(x.artifacts||[]).map((z:any)=>Number(z.version_code??0)));
    if(yc!==xc)return yc-xc;
    return new Date(y.published_at||y.created_at).getTime()-new Date(x.published_at||x.created_at).getTime();
   });
   const x=list[0];if(!x)return undefined;
   return {id:String(x.id),applicationId:{provider:a.provider,project:a.project},version:{name:x.version_name,code:x.version_code??undefined},channel:x.channel,status:x.status,title:x.title,notes:x.notes,publishedAt:x.published_at,sourceReleaseId:x.source_release_id,artifacts:(x.artifacts||[]).map((z:any)=>({id:String(z.id),platform:z.platform,kind:z.kind,filename:z.filename,downloadUrl:z.download_url,sizeBytes:z.size_bytes,sha256:z.sha256,packageIdentity:z.package_identity,signingCertificateSha256:z.signing_certificate_sha256,versionCode:z.version_code,signingStatus:z.signing_status,signingAuthority:z.signing_authority,signingError:z.signing_error}))};
  })();
  const catalogPackageIdentity=latestRelease?.artifacts?.find((z:any)=>z.platform==="android"&&z.packageIdentity)?.packageIdentity||a.package_identity||releases.flatMap((x:any)=>x.artifacts||[]).map((z:any)=>z.package_identity).find(Boolean);
  return {databaseId:Number(a.id),id:{provider:a.provider,project:a.project},packageIdentity:catalogPackageIdentity,name:a.name,description:a.description,sourceUrl:a.source_url,iconUrl:a.icon_url,platforms:a.platforms??[],category:a.category??"Other",functionality:a.functionality??[],screenshots:a.screenshots??[],permissions:a.permissions??[],latest:latestRelease};
 });
}