import type {StoreApp} from "../domain/catalog";
import {compareVersionNamesNewestFirst} from "../domain/version";
import {parseCatalogTimestamp} from "../domain/time";

export interface ManagerOptions {
  loadCatalog: () => Promise<StoreApp[]>;
}

function releaseCode(release:any):number {
  const releaseCode=Number(release?.version?.code ?? 0);
  const artifactCodes=(Array.isArray(release?.artifacts)?release.artifacts:[])
    .map((artifact:any)=>Number(artifact?.versionCode ?? 0))
    .filter((code:number)=>Number.isFinite(code));
  return Math.max(releaseCode,...artifactCodes);
}

function releaseTime(release:any):number {
  return parseCatalogTimestamp(release?.publishedAt ?? release?.published_at);
}

/**
 * Deterministic AEM Manager.
 *
 * The Manager coordinates catalog, release, download and installer state.
 * It prevents overlapping refreshes and applies one consistent "latest eligible
 * release" rule everywhere the UI asks for a channel release.
 */
export function createManager(options:ManagerOptions){
  let refreshing:Promise<StoreApp[]>|null=null;

  const selectLatest=(app:StoreApp)=>app.latest;

  const compareReleases=(a:any,b:any)=>{
    const codeDiff=releaseCode(b)-releaseCode(a);
    if(codeDiff!==0)return codeDiff;
    const namedVersion=compareVersionNamesNewestFirst(String(a?.version?.name??a?.version_name??""),String(b?.version?.name??b?.version_name??""));
    if(namedVersion)return namedVersion;
    return releaseTime(b)-releaseTime(a);
  };

  return {
    async refreshCatalog():Promise<StoreApp[]>{
      if(refreshing)return refreshing;
      refreshing=options.loadCatalog().finally(()=>{refreshing=null});
      return refreshing;
    },

    selectLatest,

    /** Select the newest published Android release with a ready installable package. */
    selectLatestRelease(releases:any[]){
      const eligible=(Array.isArray(releases)?releases:[])
        .filter((release:any)=>release?.status==="published")
        .filter((release:any)=>(release?.artifacts||[]).some((artifact:any)=>
          artifact?.platform==="android" &&
          ["apk","apks","xapk","apkm"].includes(String(artifact?.kind||"").toLowerCase()) &&
          (artifact?.signingStatus ?? artifact?.signing_status ?? "ready")==="ready"
        ));
      const preferredChannel=["stable","beta","development"].find(channel=>eligible.some((release:any)=>String(release.channel||"").toLowerCase()===channel));
      return eligible
        .filter((release:any)=>!preferredChannel||String(release.channel||"").toLowerCase()===preferredChannel)
        .sort(compareReleases)[0];
    }
  };
}
