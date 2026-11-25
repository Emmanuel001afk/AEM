import {selectLatestWindowsRelease} from "../../domain/version";
import {selectPendingAndroidUpdate,type StoreApp} from "../../domain/catalog";
import {supabaseRequest} from "../supabase/client";

export function mapSupabaseRelease(appMeta:{provider:string;project:string},x:any):any{
 if(!x)return undefined;
 return {
  id:String(x.id),
  applicationId:{provider:appMeta.provider,project:appMeta.project},
  version:{name:x.version_name??x.version?.name??"Unknown",code:x.version_code??x.version?.code??undefined},
  channel:x.channel,
  status:x.status,
  title:x.title,
  notes:x.notes,
  publishedAt:x.published_at??x.publishedAt,
  sourceReleaseId:x.source_release_id??x.sourceReleaseId,
  artifacts:(x.artifacts||[]).map((z:any)=>({
   id:String(z.id),
   platform:z.platform,
   kind:z.kind,
   filename:z.filename,
   downloadUrl:z.download_url??z.downloadUrl,
   sizeBytes:z.size_bytes??z.sizeBytes,
   sha256:z.sha256,
   packageIdentity:z.package_identity??z.packageIdentity,
   signingCertificateSha256:z.signing_certificate_sha256??z.signingCertificateSha256,
   versionCode:z.version_code??z.versionCode,
   versionName:z.artifact_version_name??z.versionName,
   sourceUpdatedAt:z.source_updated_at??z.sourceUpdatedAt,
   signingStatus:z.signing_status??z.signingStatus,
   signingAuthority:z.signing_authority??z.signingAuthority,
   signingError:z.signing_error??z.signingError
  }))
 };
}

const ANDROID_KINDS=new Set(["apk","apks","xapk","apkm"]);
function isReadyAndroidArtifact(z:any){
 return z?.platform==="android"&&ANDROID_KINDS.has(String(z?.kind||"").toLowerCase())&&(z.signing_status??z.signingStatus)==="ready";
}
function releaseFreshnessMs(r:any):number{
 const arts=Array.isArray(r?.artifacts)?r.artifacts.filter(isReadyAndroidArtifact):[];
 const times=[
  Date.parse(String(r?.published_at??r?.publishedAt??r?.created_at??r?.createdAt??""))||0,
  ...arts.map((z:any)=>Date.parse(String(z?.source_updated_at??z?.sourceUpdatedAt??""))||0)
 ];
 return Math.max(0,...times);
}

export async function loadSupabaseCatalog():Promise<StoreApp[]>{
 const r=await supabaseRequest("/rest/v1/applications?select=*,releases!releases_application_id_fkey(*,artifacts!artifacts_release_id_fkey(*))&order=name.asc",{cache:"no-store",headers:{"Cache-Control":"no-cache"}});
 if(!r.ok) throw new Error(`Supabase catalog request failed: ${r.status}`);
 const rows=await r.json();
 return rows.map((a:any)=>{
  const appMeta={provider:a.provider,project:a.project};
  const releases=Array.isArray(a.releases)?a.releases.map((x:any)=>({...x,artifacts:Array.isArray(x.artifacts)?x.artifacts:[]})).filter((x:any)=>x.status==="published"):[];
  const toRelease=(x:any)=>mapSupabaseRelease(appMeta,x);
  // The actionable catalog release must have a ready Android artifact.
  // A newer published release with signing_status=pending/processing must not
  // block installation/update from the newest already-ready APK.
  const readyAndroidRaw=releases.filter((x:any)=>x.status==="published"&&(x.artifacts||[]).some(isReadyAndroidArtifact)).sort((x:any,y:any)=>{
   const yReady=(y.artifacts||[]).filter(isReadyAndroidArtifact);
   const xReady=(x.artifacts||[]).filter(isReadyAndroidArtifact);
   const yc=Math.max(Number(y.version_code??0),...yReady.map((z:any)=>Number(z.version_code??0)));
   const xc=Math.max(Number(x.version_code??0),...xReady.map((z:any)=>Number(z.version_code??0)));
   if(yc!==xc)return yc-xc;
   const yt=releaseFreshnessMs(y),xt=releaseFreshnessMs(x);
   const yHasRelease=yReady.some((z:any)=>!/(^|[-_. ])debug([-. _]|$)/i.test(String(z.filename||"")))?1:0;
   const xHasRelease=xReady.some((z:any)=>!/(^|[-_. ])debug([-. _]|$)/i.test(String(z.filename||"")))?1:0;
   if(yHasRelease!==xHasRelease)return yHasRelease-xHasRelease;
   return yt-xt;
  });
  const androidReleases=readyAndroidRaw.map(toRelease);
  const preferMobileAbi=typeof navigator!=="undefined"&&/android/i.test(navigator.userAgent||"")&&!/x86_64|amd64/i.test(navigator.userAgent||"");
  const isX86Only=(rel:any)=>{
   const arts=(rel?.artifacts||[]).filter((z:any)=>z.platform==="android"&&ANDROID_KINDS.has(String(z.kind||"").toLowerCase())&&z.signingStatus==="ready");
   return arts.length>0&&arts.every((z:any)=>/x86_64|amd64/i.test(String(z.filename||"")));
  };
  const topCode=androidReleases[0]?Math.max(Number(androidReleases[0].version?.code??0),...(androidReleases[0].artifacts||[]).map((z:any)=>Number(z.versionCode??0))):0;
  const latestRelease=(preferMobileAbi&&androidReleases.length>1&&isX86Only(androidReleases[0])
   ?androidReleases.find((rel:any)=>Math.max(Number(rel.version?.code??0),...(rel.artifacts||[]).map((z:any)=>Number(z.versionCode??0)))===topCode&&!isX86Only(rel))||androidReleases[0]
   :androidReleases[0]);
  const pendingAndroidUpdate=selectPendingAndroidUpdate(releases,a.package_identity,topCode);
  const windowsLatest=selectLatestWindowsRelease(releases.map(toRelease));
  const catalogPackageIdentity=latestRelease?.artifacts?.find((z:any)=>z.platform==="android"&&z.packageIdentity)?.packageIdentity||a.package_identity||releases.flatMap((x:any)=>x.artifacts||[]).map((z:any)=>z.package_identity).find(Boolean);
  return {databaseId:Number(a.id),id:{provider:a.provider,project:a.project},packageIdentity:catalogPackageIdentity,name:a.name,description:a.description,sourceUrl:a.source_url,iconUrl:a.icon_url,platforms:a.platforms??[],category:a.category??"Other",functionality:a.functionality??[],screenshots:a.screenshots??[],permissions:a.permissions??[],latest:latestRelease,androidReleases,windowsLatest,pendingAndroidUpdate};
 });
}