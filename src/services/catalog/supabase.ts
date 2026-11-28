import {compareVersionNamesNewestFirst,selectLatestWindowsRelease} from "../../domain/version";
import {windowsArchives} from "../../domain/platform";
import {parseCatalogTimestamp} from "../../domain/time";
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
   sourceExpiresAt:z.source_expires_at??z.sourceExpiresAt,
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
  parseCatalogTimestamp(r?.published_at??r?.publishedAt??r?.created_at??r?.createdAt),
  ...arts.map((z:any)=>parseCatalogTimestamp(z?.source_updated_at??z?.sourceUpdatedAt))
 ];
 return Math.max(0,...times);
}

export async function loadSupabaseCatalog():Promise<StoreApp[]>{
 const r=await supabaseRequest("/rest/v1/applications?select=*,releases!releases_application_id_fkey(*,artifacts!artifacts_release_id_fkey(*))&order=name.asc",{cache:"no-store",headers:{"Cache-Control":"no-cache"}});
 if(!r.ok) throw new Error(`Supabase catalog request failed: ${r.status}`);
 const rows=await r.json();
 return rows.map((a:any)=>{
  const appMeta={provider:a.provider,project:a.project};
  // This historical EMA Actions import contains only two onedir executables,
  // not the supporting files required to run either of them. Keep the rows in
  // the database, but do not advertise them as complete Windows installers.
  const isIncompleteEmaRelease=(x:any)=>String(a.project||"").toLowerCase()==="emmanuel001afk/ema"&&String(x.source_release_id||"")==="github-actions-artifact-14909777427";
  const rawReleases=Array.isArray(a.releases)?a.releases:[];
  const windowsPackageIncomplete=rawReleases.some((x:any)=>x.status==="published"&&isIncompleteEmaRelease(x)&&(x.artifacts||[]).some((z:any)=>z.platform==="windows"&&z.kind==="exe"));
  const releases=rawReleases.map((x:any)=>({...x,artifacts:Array.isArray(x.artifacts)?x.artifacts.filter((z:any)=>!(isIncompleteEmaRelease(x)&&z.platform==="windows"&&z.kind==="exe")):[]})).filter((x:any)=>x.status==="published");
  const toRelease=(x:any)=>mapSupabaseRelease(appMeta,x);
  // A configured package identity is authoritative. Never replace a launcher
  // with another APK merely because it appeared first in a repository release.
  const packageIdentity=String(a.package_identity||"");
  const matchesIdentity=(z:any)=>!packageIdentity||String(z.package_identity??z.packageIdentity??"")===packageIdentity;
  const ready=(r:any)=>(r.artifacts||[]).filter((z:any)=>isReadyAndroidArtifact(z)&&matchesIdentity(z));
  const isDebug=(z:any)=>/(^|[-_. ])debug([-. _]|$)/i.test(String(z.filename||""));
  const preferMobileAbi=typeof navigator!=="undefined"&&/android/i.test(navigator.userAgent||"")&&!/x86_64|amd64/i.test(navigator.userAgent||"");
  const mobileCompatible=(z:any)=>!/(^|[-_.])(x86_64|amd64|x86)([-. _]|$)/i.test(String(z.filename||""));
  let candidates=releases.filter((r:any)=>ready(r).length>0);
  if(preferMobileAbi){
   // Do not choose an explicitly x86-only APK for an ARM phone.
   candidates=candidates.filter((r:any)=>ready(r).some(mobileCompatible));
  }
  const suitable=(r:any)=>preferMobileAbi?ready(r).filter(mobileCompatible):ready(r);
  const hasRelease=(r:any)=>suitable(r).some((z:any)=>!isDebug(z));
  // Release builds take precedence over debug builds, irrespective of channel.
  // Within that class select the newest version; at equal version prefer a
  // published GitHub release over a workflow copy, then the freshest source.
  const readyAndroidRaw=candidates.sort((x:any,y:any)=>{
   const releaseDiff=Number(hasRelease(y))-Number(hasRelease(x));if(releaseDiff)return releaseDiff;
   const chosen=(r:any)=>suitable(r).filter((z:any)=>hasRelease(r)?!isDebug(z):true);
   const xc=Math.max(0,...chosen(x).map((z:any)=>Number(z.version_code??z.versionCode??0)));
   const yc=Math.max(0,...chosen(y).map((z:any)=>Number(z.version_code??z.versionCode??0)));
   if(yc!==xc)return yc-xc;
   const named=compareVersionNamesNewestFirst(String(x.version_name??x.version?.name??""),String(y.version_name??y.version?.name??""));if(named)return named;
   const source=(r:any)=>String(r.source_release_id??r.sourceReleaseId??"").startsWith("github-release-")?1:0;
   const sourceDiff=source(y)-source(x);if(sourceDiff)return sourceDiff;
   return releaseFreshnessMs(y)-releaseFreshnessMs(x);
  });
  const androidReleases=readyAndroidRaw.map(toRelease);
  const latestRelease=androidReleases[0];
  const topCode=latestRelease?Math.max(0,...(latestRelease.artifacts||[]).filter((z:any)=>!packageIdentity||z.packageIdentity===packageIdentity).map((z:any)=>Number(z.versionCode??0))):0;
  const latestReadyVersionName=readyAndroidRaw[0]?.artifacts?.find((z:any)=>isReadyAndroidArtifact(z)&&matchesIdentity(z))?.artifact_version_name||readyAndroidRaw[0]?.version_name||undefined;
  const pendingAndroidUpdate=selectPendingAndroidUpdate(releases,packageIdentity,topCode,latestReadyVersionName);
  const windowsLatest=selectLatestWindowsRelease(releases.map(toRelease));
  const windowsArchiveLatest=releases.map(toRelease).filter((r:any)=>windowsArchives(r).length).sort((a:any,b:any)=>{
   const timestamp=(r:any)=>Math.max(parseCatalogTimestamp(r.publishedAt),...windowsArchives(r).map((z:any)=>parseCatalogTimestamp(z.sourceUpdatedAt)));
   return timestamp(b)-timestamp(a);
  })[0];
  const catalogPackageIdentity=a.package_identity||latestRelease?.artifacts?.find((z:any)=>z.platform==="android"&&z.packageIdentity)?.packageIdentity||releases.flatMap((x:any)=>x.artifacts||[]).map((z:any)=>z.package_identity).find(Boolean);
  return {databaseId:Number(a.id),id:{provider:a.provider,project:a.project},packageIdentity:catalogPackageIdentity,name:a.name,description:a.description,sourceUrl:a.source_url,iconUrl:a.icon_url,platforms:a.platforms??[],category:a.category??"Other",functionality:a.functionality??[],screenshots:a.screenshots??[],permissions:a.permissions??[],latest:latestRelease,androidReleases,windowsLatest,windowsArchiveLatest,windowsPackageIncomplete,pendingAndroidUpdate};
 });
}