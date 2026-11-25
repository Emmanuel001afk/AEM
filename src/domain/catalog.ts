import type {Application,Release,ReleaseChannel,Platform} from "./model";
export interface StoreApp extends Application { category:string; featured?:boolean; functionality:string[]; screenshots:string[]; permissions:string[]; latest?: Release; androidReleases?: Release[]; windowsLatest?: Release; pendingAndroidUpdate?: {versionName:string;versionCode:number;status:"pending"|"processing"|"failed";packageIdentity?:string}; }
export interface CatalogFilter { query?:string; category?:string; platform?:Platform; channel?:ReleaseChannel; }
export function selectPendingAndroidUpdate(releases:any[],packageIdentity?:string,latestReadyCode=0){
 const candidates=(Array.isArray(releases)?releases:[]).filter((release:any)=>release?.status==="published").flatMap((release:any)=>(Array.isArray(release.artifacts)?release.artifacts:[])
  .filter((artifact:any)=>{
   const identity=artifact?.package_identity??artifact?.packageIdentity;
   return artifact?.platform==="android"&&["apk","apks","xapk","apkm"].includes(String(artifact?.kind||"").toLowerCase())&&["pending","processing","failed"].includes(String(artifact?.signing_status??artifact?.signingStatus??""))&&(!packageIdentity||identity===packageIdentity);
  })
  .map((artifact:any)=>({release,artifact,versionCode:Math.max(Number(release.version_code??release.version?.code??0),Number(artifact.version_code??artifact.versionCode??0))}))
  .filter((candidate:any)=>candidate.versionCode>latestReadyCode));
 candidates.sort((x:any,y:any)=>y.versionCode-x.versionCode||new Date(y.release.published_at||y.release.publishedAt||y.release.created_at||y.release.createdAt||0).getTime()-new Date(x.release.published_at||x.release.publishedAt||x.release.created_at||x.release.createdAt||0).getTime());
 const candidate=candidates[0];if(!candidate)return undefined;
 const artifact=candidate.artifact;
 return {versionName:artifact.artifact_version_name||artifact.versionName||candidate.release.version_name||candidate.release.version?.name||String(candidate.versionCode),versionCode:candidate.versionCode,status:String(artifact.signing_status??artifact.signingStatus),packageIdentity:artifact.package_identity??artifact.packageIdentity};
}
export function filterCatalog(apps:StoreApp[], filter:CatalogFilter){const q=filter.query?.trim().toLowerCase();return apps.filter(a=>(!q||[a.name,a.description,a.category,...a.functionality].join(" ").toLowerCase().includes(q))&&(!filter.category||a.category===filter.category)&&(!filter.platform||a.platforms.includes(filter.platform)));}
