import type {ReleaseEvent,Release,ArtifactKind,Platform} from "../../domain/model";
import type {ReleaseSourceProvider} from "./provider";

function kind(n:string):ArtifactKind {
  n=n.toLowerCase();
  if(n.endsWith(".apk"))return"apk";
  if(n.endsWith(".apks"))return"apks";
  if(n.endsWith(".aab"))return"aab";
  if(n.endsWith(".exe"))return"exe";
  if(n.endsWith(".msix"))return"msix";
  if(n.endsWith(".appimage"))return"appimage";
  if(n.endsWith(".deb"))return"deb";
  if(n.endsWith(".rpm"))return"rpm";
  if(n.endsWith(".dmg"))return"dmg";
  if(n.endsWith(".pkg"))return"pkg";
  return"other";
}
function platform(k:ArtifactKind):Platform {
  if(["apk","apks","aab"].includes(k))return"android";
  if(["exe","msix"].includes(k))return"windows";
  if(["appimage","deb","rpm"].includes(k))return"linux";
  if(["dmg","pkg"].includes(k))return"macos";
  return"web";
}
function channel(r:any):"stable"|"beta"|"development" {
  const text=String(r.tag_name??r.name??"").toLowerCase();
  if(r.prerelease || /(^|[-_.])(beta|b)([-_.]|\d|$)/.test(text))return"beta";
  if(/(^|[-_.])(dev|development|nightly|alpha|canary)([-_.]|\d|$)/.test(text))return"development";
  return"stable";
}

export const githubReleaseProvider:ReleaseSourceProvider={
  id:"github",
  async verifyEvent(event) {
    const payload=event.payload as any;
    return Boolean(payload && (payload.release || payload.tag_name || payload.name));
  },
  async normalizeReleaseEvent(event) {
    const p=event.payload as any;
    const r=p.release??p;
    const repo=p.repository??{};
    const artifacts=(Array.isArray(r.assets)?r.assets:[]).map((x:any)=>{
      const k=kind(String(x.name??""));
      return {
        id:String(x.id??x.name),
        platform:platform(k),
        kind:k,
        filename:String(x.name??""),
        downloadUrl:String(x.browser_download_url??x.url??""),
        sizeBytes:typeof x.size==="number"?x.size:undefined
      };
    });
    return {
      id:event.provider+":"+event.sourceReleaseId,
      applicationId:{provider:"github",project:String(repo.full_name??event.sourceProject)},
      version:{name:String(r.tag_name??r.name??"unknown")},
      channel:channel(r),
      status:r.draft?"draft":(r.published_at?"published":"draft"),
      title:r.name,
      notes:r.body,
      publishedAt:r.published_at,
      sourceReleaseId:event.sourceReleaseId,
      artifacts
    } satisfies Release;
  }
};
