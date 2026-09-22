import type {StoreApp} from "../domain/catalog";

export type ReleaseChannel = "stable" | "beta" | "development";

export interface ManagerOptions {
  loadCatalog: () => Promise<StoreApp[]>;
}

function releaseCode(release:any):number {
  return Number(release?.version?.code ?? 0);
}

function releaseTime(release:any):number {
  const value = release?.publishedAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Deterministic AEM Manager.
 *
 * The Manager is an orchestration layer only: the existing catalog, release,
 * build, download and installer services remain the source of their own data.
 * It prevents overlapping refreshes and applies one consistent "latest eligible
 * release" rule everywhere the UI asks for a channel release.
 */
export function createManager(options:ManagerOptions){
  let refreshing:Promise<StoreApp[]>|null=null;

  const selectLatest=(app:StoreApp,channel:ReleaseChannel)=>{
    const preferred=app.latest?.[channel];
    if(preferred) return preferred;
    return app.latest?.stable||app.latest?.beta||app.latest?.development;
  };

  const compareReleases=(a:any,b:any)=>{
    const codeDiff=releaseCode(b)-releaseCode(a);
    if(codeDiff!==0)return codeDiff;
    return releaseTime(b)-releaseTime(a);
  };

  return {
    async refreshCatalog():Promise<StoreApp[]>{
      if(refreshing)return refreshing;
      refreshing=options.loadCatalog().finally(()=>{refreshing=null});
      return refreshing;
    },

    selectLatest,

    /**
     * Useful for callers that already have release rows (history/admin views).
     * Published Android releases only; intermediate successful builds remain
     * historical and do not become sequential user updates.
     */
    selectLatestRelease(releases:any[],channel:ReleaseChannel){
      return (Array.isArray(releases)?releases:[])
        .filter((release:any)=>release?.status==="published"&&release?.channel===channel)
        .filter((release:any)=>(release?.artifacts||[]).some((artifact:any)=>
          artifact?.platform==="android" &&
          ["apk","apks","xapk","apkm"].includes(String(artifact?.kind||"").toLowerCase())
        ))
        .sort(compareReleases)[0];
    }
  };
}
