import type {Application,Release,ReleaseChannel,Platform} from "./model";
import {compareVersionNamesNewestFirst} from "./version";
import {parseCatalogTimestamp} from "./time";
export interface StoreApp extends Application { category:string; featured?:boolean; functionality:string[]; screenshots:string[]; permissions:string[]; latest?: Release; androidReleases?: Release[]; windowsLatest?: Release; pendingAndroidUpdate?: {versionName:string;versionCode:number;status:"pending"|"processing"|"failed";packageIdentity?:string}; }
export interface CatalogFilter { query?:string; category?:string; platform?:Platform; channel?:ReleaseChannel; }
export function selectPendingAndroidUpdate(releases:any[],packageIdentity?:string,latestReadyCode=0,latestReadyVersionName?:string,preferredChannel?:string){
 const candidates=(Array.isArray(releases)?releases:[]).filter((release:any)=>release?.status==="published"&&(!preferredChannel||String(release.channel||"").toLowerCase()===preferredChannel.toLowerCase())).flatMap((release:any)=>(Array.isArray(release.artifacts)?release.artifacts:[])
  .filter((artifact:any)=>{
   const identity=artifact?.package_identity??artifact?.packageIdentity;
   return artifact?.platform==="android"&&["apk","apks","xapk","apkm"].includes(String(artifact?.kind||"").toLowerCase())&&["pending","processing","failed"].includes(String(artifact?.signing_status??artifact?.signingStatus??""))&&(!packageIdentity||identity===packageIdentity);
  })
  .map((artifact:any)=>({release,artifact,versionCode:Math.max(Number(release.version_code??release.version?.code??0),Number(artifact.version_code??artifact.versionCode??0))}))
  .filter((candidate:any)=>candidate.versionCode>latestReadyCode||(candidate.versionCode===latestReadyCode&&!!latestReadyVersionName&&compareVersionNamesNewestFirst(String(candidate.artifact.artifact_version_name??candidate.artifact.versionName??candidate.release.version_name??candidate.release.version?.name??""),latestReadyVersionName)<0)));
 candidates.sort((x:any,y:any)=>y.versionCode-x.versionCode||compareVersionNamesNewestFirst(String(x.artifact.artifact_version_name??x.artifact.versionName??x.release.version_name??x.release.version?.name??""),String(y.artifact.artifact_version_name??y.artifact.versionName??y.release.version_name??y.release.version?.name??""))||parseCatalogTimestamp(y.release.published_at||y.release.publishedAt||y.release.created_at||y.release.createdAt)-parseCatalogTimestamp(x.release.published_at||x.release.publishedAt||x.release.created_at||x.release.createdAt));
 const candidate=candidates[0];if(!candidate)return undefined;
 const artifact=candidate.artifact;
 return {versionName:artifact.artifact_version_name||artifact.versionName||candidate.release.version_name||candidate.release.version?.name||String(candidate.versionCode),versionCode:candidate.versionCode,status:String(artifact.signing_status??artifact.signingStatus),packageIdentity:artifact.package_identity??artifact.packageIdentity};
}
export function filterCatalog(apps:StoreApp[], filter:CatalogFilter){const q=filter.query?.trim().toLowerCase();return apps.filter(a=>(!q||[a.name,a.description,a.category,...a.functionality].join(" ").toLowerCase().includes(q))&&(!filter.category||a.category===filter.category)&&(!filter.platform||a.platforms.includes(filter.platform)));}
