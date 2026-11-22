import { createClient } from "npm:@supabase/supabase-js@2";

const GH = "https://api.github.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-aem-sync-secret",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: cors });
const client = () => {
  const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Supabase server key unavailable");
  return createClient(Deno.env.get("SUPABASE_URL")!, key);
};
const artifactKind = (name: string): string | null => {
  const n = name.toLowerCase();
  return ["apk", "apks", "xapk", "apkm", "exe"].find((ext) => n.endsWith(`.${ext}`)) || null;
};
const platform = (kind: string) => kind === "exe" ? "windows" : "android";
const releaseChannel = (text: string): "stable" | "beta" | "development" => {
  if (/(^|[-_.])(beta|b)([-_.]|\d|$)/i.test(text)) return "beta";
  if (/(^|[-_.])(dev|development|debug|nightly|alpha|canary)([-_.]|\d|$)/i.test(text)) return "development";
  return "stable";
};
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");
const gh = async (url: string, headers: HeadersInit) => {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  return response.json();
};

async function unzipEntry(buf:Uint8Array,wanted:string){
 const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
 const u16=(p:number)=>dv.getUint16(p,true),u32=(p:number)=>dv.getUint32(p,true);
 const e=Math.min(buf.length-22,buf.length-65558);
 for(let p=buf.length-22;p>=e;p--){
  if(u32(p)!==0x06054b50)continue;
  const n=u16(p+10),off=u32(p+16); let q=off;
  for(let i=0;i<n&&q+46<=buf.length;i++){
   if(u32(q)!==0x02014b50)break;
   const method=u16(q+10),cs=u32(q+20),us=u32(q+24),nl=u16(q+28),xl=u16(q+30),cl=u16(q+32),lo=u32(q+42);
   const name=new TextDecoder().decode(buf.slice(q+46,q+46+nl));
   q+=46+nl+xl+cl;
   if(name!==wanted)continue;
   const ln=u16(lo+26),lx=u16(lo+28),raw=buf.slice(lo+30+ln+lx,lo+30+ln+lx+cs);
   if(method===0)return raw;
   if(method===8)return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
   return null;
  }
 }
 return null;
}
async function apkMetadata(buf:Uint8Array){
 const manifest=await unzipEntry(buf,"AndroidManifest.xml");
 return manifest?parseApkManifest(manifest):{};
}

function readU16(v:DataView,p:number){return v.getUint16(p,true)}
function readU32(v:DataView,p:number){return v.getUint32(p,true)}
function readLen8(b:Uint8Array,p:number){let n=0,shift=0,x=0;do{x=b[p++];n|=(x&127)<<shift;shift+=7}while(x&128);return [n,p] as const}
function readLen16(v:DataView,p:number){const first=readU16(v,p);if(first&0x8000)return [((first&0x7fff)<<16)|readU16(v,p+2),p+4] as const;return [first,p+2] as const}
function axmlStrings(buf:Uint8Array,v:DataView,off:number){
 if(readU16(v,off)!==1)return null;
 const count=readU32(v,off+8),flags=readU32(v,off+16),start=readU32(v,off+20),utf8=(flags&0x100)!==0,base=off+start;
 const offs=Array.from({length:count},(_,i)=>readU32(v,off+28+i*4));
 return (idx:number)=>{if(idx<0||idx>=offs.length)return "";let p=base+offs[idx];
  if(utf8){const a=readLen8(buf,p),b=readLen8(buf,a[1]);return new TextDecoder().decode(buf.slice(b[1],b[1]+a[0]))}
  const a=readLen16(v,p);return new TextDecoder("utf-16le").decode(buf.slice(a[1],a[1]+a[0]*2))}
}
function parseApkManifest(buf:Uint8Array){
 try{
  const v=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  if(buf.length<8||readU16(v,0)!==3)return {};
  let p=8,strings:any=null,packageName="",versionCode:number|undefined,versionName:string|undefined;
  while(p+8<=buf.length){
   const type=readU16(v,p),size=readU32(v,p+4);if(size<8||p+size>buf.length)break;
   if(type===1)strings=axmlStrings(buf,v,p);
   else if(type===0x102&&strings&&p+36<=buf.length){
    const attrStart=readU16(v,p+24),attrSize=readU16(v,p+26),attrCount=readU16(v,p+28),attrs=p+16+attrStart;
    for(let i=0;i<attrCount;i++){
     const q=attrs+i*attrSize;if(q+20>p+size)break;
     const name=strings(readU32(v,q+4)),raw=readU32(v,q+8),dataType=buf[q+15],data=readU32(v,q+16),value=raw===0xffffffff?"":strings(raw);
     if(name==="package")packageName=value||packageName;
     if(name==="versionName")versionName=value;
     if(name==="versionCode")versionCode=dataType===0x10||dataType===0x11?data:Number(value);
    }
   }
   p+=size;
  }
  return {packageName,versionCode,versionName};
 }catch{return {}}
}

async function archiveBinaries(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (p: number) => view.getUint16(p, true);
  const u32 = (p: number) => view.getUint32(p, true);
  const end = Math.min(data.length - 22, data.length - 65558);
  for (let p = data.length - 22; p >= end; p--) {
    if (u32(p) !== 0x06054b50) continue;
    const count = u16(p + 10);
    let cursor = u32(p + 16);
    const found: Array<{name: string; bytes: Uint8Array; packageName?: string; versionCode?: number; versionName?: string}> = [];
    for (let i = 0; i < count && cursor + 46 <= data.length; i++) {
      if (u32(cursor) !== 0x02014b50) break;
      const method = u16(cursor + 10), compressed = u32(cursor + 20), size = u32(cursor + 24);
      const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), local = u32(cursor + 42);
      const fullName = new TextDecoder().decode(data.slice(cursor + 46, cursor + 46 + nameLength));
      cursor += 46 + nameLength + extraLength + commentLength;
      const kind = artifactKind(fullName);
      if (!kind || size > (kind === "exe" ? 450 : 100) * 1024 * 1024) continue;
      const localName = u16(local + 26), localExtra = u16(local + 28);
      const raw = data.slice(local + 30 + localName + localExtra, local + 30 + localName + localExtra + compressed);
      let bytes = raw;
      if (method === 8) bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      else if (method !== 0) continue;
      const metadata = kind === "apk" ? await apkMetadata(bytes) : {};
      if (kind === "apk" && !metadata.packageName) continue;
      found.push({ name: fullName.split("/").pop() || `application.${kind}`, bytes,
        packageName: metadata.packageName, versionCode: metadata.versionCode, versionName: metadata.versionName });
    }
    return found;
  }
  return [];
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function retainCurrentAndPreviousApks(sb: any, applicationId: number) {
  const result = await sb.from("artifacts")
    .select("id,filename,download_url,release_id,version_code,signing_status,releases!inner(id,version_code,version_name,published_at,created_at,application_id)")
    .eq("platform", "android").eq("kind", "apk").eq("releases.application_id", applicationId);
  if (result.error) throw result.error;
  const groups = new Map<string, { code: number; date: number; rows: any[] }>();
  for (const artifact of result.data || []) {
    if (artifact.signing_status === "failed" || artifact.signing_status === "processing") continue;
    const release = Array.isArray(artifact.releases) ? artifact.releases[0] : artifact.releases;
    if (!release) continue;
    const key = String(release.id);
    const versionCode = Math.max(Number(artifact.version_code || 0), Number(release.version_code || 0));
    const date = Date.parse(release.published_at || release.created_at || "") || 0;
    const group = groups.get(key) || { code: 0, date: 0, rows: [] };
    group.code = Math.max(group.code, versionCode); group.date = Math.max(group.date, date); group.rows.push(artifact);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].code - a[1].code || b[1].date - a[1].date);
  const keep = new Set(ordered.slice(0, 2).map(([id]) => id));
  const obsolete = ordered.filter(([id]) => !keep.has(id)).flatMap(([, group]) => group.rows);
  const removals = obsolete.map((artifact) => {
    const url = new URL(String(artifact.download_url || ""));
    const marker = "/storage/v1/object/public/aem-artifacts/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;
    return { id: artifact.id, path: decodeURIComponent(url.pathname.slice(index + marker.length)) };
  }).filter(Boolean) as Array<{id:number;path:string}>;
  if (!removals.length) return 0;
  const removed = await sb.storage.from("aem-artifacts").remove(removals.map((x) => x.path));
  if (removed.error) throw new Error(`APK retention could not remove obsolete objects: ${removed.error.message}`);
  const deleted = await sb.from("artifacts").delete().in("id", removals.map((x) => x.id));
  if (deleted.error) throw new Error(`APK retention could not remove obsolete artifact records: ${deleted.error.message}`);
  return removals.length;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const sb = client();
  const started = new Date();
  try {
    const supplied = (request.headers.get("x-aem-sync-secret") || "").trim();
    const secret = await sb.rpc("aem_get_sync_secret");
    if (secret.error || !secret.data || supplied !== String(secret.data)) return json({ ok: false, error: "Unauthorized sync caller." }, 401);
    const token = (Deno.env.get("AEM_GITHUB_TOKEN") || Deno.env.get("GITHUB_TOKEN") || "").trim();
    if (!token) return json({ ok: false, error: "AEM_GITHUB_TOKEN is not configured." }, 503);
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
    const user = await gh(`${GH}/user`, headers);
    if (user.login !== "Emmanuel001afk") return json({ error: "GitHub token is not for Emmanuel001afk." }, 403);

    const state = (await sb.from("source_sync_state").select("status,last_started_at,last_success_at,repositories_scanned,applications_discovered,releases_discovered,artifacts_discovered").eq("provider", "github").maybeSingle()).data;
    const now = Date.now(), lastSuccess = state?.last_success_at ? Date.parse(state.last_success_at) : 0;
    const lastStart = state?.last_started_at ? Date.parse(state.last_started_at) : 0;
    if (state?.status === "running" && now - lastStart < 300000) return json({ ok: true, throttled: true });
    if (lastSuccess && now - lastSuccess < 30000) return json({ ok: true, throttled: true, last_success_at: state.last_success_at });
    await sb.from("source_sync_state").upsert({ provider: "github", status: "running", last_started_at: started.toISOString(), last_error: null, updated_at: started.toISOString() }, { onConflict: "provider" });

    const repositories: any[] = [];
    for (let page = 1; ; page++) {
      const batch = await gh(`${GH}/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`, headers);
      repositories.push(...batch);
      if (batch.length < 100) break;
    }
    const startIndex = state?.status === "running" ? Math.min(Number(state.repositories_scanned || 0), repositories.length) : 0;
    const batchRepositories = repositories.slice(startIndex, startIndex + 1);
    const totals = {
      applications: state?.status === "running" ? Number(state.applications_discovered || 0) : 0,
      releases: state?.status === "running" ? Number(state.releases_discovered || 0) : 0,
      artifacts: state?.status === "running" ? Number(state.artifacts_discovered || 0) : 0,
      failures: 0,
    };
    const failureDetails: string[] = [];
    for (let repoOffset = 0; repoOffset < batchRepositories.length; repoOffset++) {
      const repo = batchRepositories[repoOffset];
      try {
        const tree = await gh(`${GH}/repos/${repo.full_name}/git/trees/${repo.default_branch || "main"}?recursive=1`, headers).catch(() => ({ tree: [] }));
        const treeFiles = (tree.tree || []).filter((x: any) => x.type === "blob" && artifactKind(String(x.path)) && Number(x.size || 0) <= 50 * 1024 * 1024 && !/(^|\/)(tests?|fixtures?|samples?)\//i.test(String(x.path)));
        const sourceFiles: any[] = [];
        for (const plat of ["android", "windows"]) {
          const file = treeFiles.find((x: any) => platform(artifactKind(String(x.path)) || "") === plat);
          if (file) sourceFiles.push(file);
        }
        const releaseRows = await gh(`${GH}/repos/${repo.full_name}/releases?per_page=50`, headers).catch(() => []);
        const releases = Array.isArray(releaseRows) ? releaseRows
          .filter((r: any) => !r.draft && (r.assets || []).some((a: any) => artifactKind(a.name)))
          .sort((a: any, b: any) => Date.parse(b.published_at || b.created_at || 0) - Date.parse(a.published_at || a.created_at || 0)
          ).slice(0, 2) : [];
        const runs = await gh(`${GH}/repos/${repo.full_name}/actions/runs?status=success&per_page=1`, headers).catch(() => ({ workflow_runs: [] }));
        const actionRuns = runs.workflow_runs || [];
        const platforms = new Set<string>(sourceFiles.map((f: any) => platform(artifactKind(String(f.path)) || "")));
        for (const release of releases) for (const asset of release.assets || []) {
          const kind = artifactKind(String(asset.name)); if (kind) platforms.add(platform(kind));
        }
        let hasWorkflowCandidates = false;
        for (const run of actionRuns) {
          const items = await gh(`${GH}/repos/${repo.full_name}/actions/runs/${run.id}/artifacts?per_page=20&direction=desc`, headers).catch(() => ({ artifacts: [] }));
          for (const item of items.artifacts || []) {
            if (item.expired || !/(apk|android|build|release|windows|exe)/i.test(String(item.name))) continue;
            hasWorkflowCandidates = true;
            platforms.add(/windows|exe/i.test(String(item.name)) ? "windows" : "android");
          }
        }
        if (!platforms.size && !hasWorkflowCandidates) continue;

        let app = (await sb.from("applications").select("id,project,name,package_identity,platforms,description_source,icon_source")
          .eq("provider", "github").eq("project", repo.full_name).maybeSingle()).data;
        const patch: any = {
          provider: "github", project: repo.full_name, source_external_id: String(repo.id),
          source_visibility: repo.private ? "private" : "public",
          name: app?.name && app.name !== "Application" ? app.name : repo.name === "AEM" ? "AEM Store" : repo.name === "phormi-android" ? "Phormi" : repo.name,
          description: repo.description || null, description_source: "github", source_url: repo.html_url,
          icon_url: repo.owner?.avatar_url || null, icon_source: "github-avatar",
          platforms: Array.from(new Set([...(app?.platforms || []), ...platforms])), updated_at: new Date().toISOString(),
        };
        if (app?.description_source === "manual") { delete patch.description; delete patch.description_source; }
        if (app?.icon_source === "manual") { delete patch.icon_url; delete patch.icon_source; }
        if (!app) {
          const inserted = await sb.from("applications").insert(patch).select("id,project,package_identity,platforms").single();
          if (inserted.error) throw inserted.error; app = inserted.data; totals.applications++;
        } else {
          const updated = await sb.from("applications").update(patch).eq("id", app.id).select("id,project,package_identity,platforms").single();
          if (updated.error) throw updated.error; app = updated.data;
        }

        const save = async (release: any, filename: string, bytes: Uint8Array, kind: string, path: string, metadata: any = {}) => {
          const upload = await sb.storage.from("aem-artifacts").upload(path, bytes, {
            contentType: kind === "apk" ? "application/vnd.android.package-archive" : kind === "exe" ? "application/vnd.microsoft.portable-executable" : "application/octet-stream",
            upsert: true,
          });
          if (upload.error) throw upload.error;
          const hash = await sha256(bytes);
          const payload = {
            release_id: release.id, platform: platform(kind), kind, filename,
            download_url: `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`,
            size_bytes: bytes.byteLength, sha256: hash,
            package_identity: kind === "exe" ? `github:${app!.project}` : metadata.packageName || app!.package_identity || null,
            version_code: metadata.versionCode ?? null,
            signing_status: kind === "apk" ? "pending" : "ready",
          };
          const prior = await sb.from("artifacts").select("id").eq("release_id", release.id).eq("filename", filename).maybeSingle();
          const result = prior.data ? await sb.from("artifacts").update(payload).eq("id", prior.data.id) : await sb.from("artifacts").insert(payload);
          if (result.error) throw result.error; totals.artifacts++;
          if (metadata.packageName && !app!.package_identity) {
            app!.package_identity = metadata.packageName;
            await sb.from("applications").update({ package_identity: metadata.packageName, updated_at: new Date().toISOString() }).eq("id", app!.id);
          }
          const detected = platform(kind);
          if (!(app!.platforms || []).includes(detected)) {
            app!.platforms = [...(app!.platforms || []), detected];
            await sb.from("applications").update({ platforms: app!.platforms, updated_at: new Date().toISOString() }).eq("id", app!.id);
          }
        };
        const ensureRelease = async (sourceId: string, name: string, channel: string, title: string, date: string) => {
          const found = await sb.from("releases").select("id").eq("application_id", app!.id).eq("source_release_id", sourceId).maybeSingle();
          if (found.data) return found.data;
          const created = await sb.from("releases").insert({
            application_id: app!.id, source_release_id: sourceId, version_name: name,
            channel: releaseChannel(channel), status: "published", title, published_at: date,
          }).select("id").single();
          if (created.error) throw created.error; totals.releases++; return created.data;
        };

        for (const release of releases) {
          const name = String(release.tag_name || release.name || "unknown"), id = `github-release-${release.id}`;
          const validAssets: Array<{asset:any;kind:string;bytes?:Uint8Array;metadata:any;digest?:string}> = [];
          for (const asset of (release.assets || []).filter((x: any) => artifactKind(String(x.name)) && Number(x.size || 0) <= 300 * 1024 * 1024)) {
            const kind = artifactKind(String(asset.name))!;
            const size = Number(asset.size || 0);
            const digest = String(asset.digest || "").replace(/^sha256:/i, "").toLowerCase();
            // Large public EXEs stay on GitHub; never spend AEM Storage on Windows installers.
            if (kind === "exe" && !repo.private && size > 50 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(digest)) {
              validAssets.push({asset,kind,metadata:{},digest});
              continue;
            }
            if (size > 50 * 1024 * 1024) continue;
            const response = await fetch(asset.browser_download_url, { headers }); if (!response.ok) continue;
            const bytes = new Uint8Array(await response.arrayBuffer());
            const metadata = kind === "apk" ? await apkMetadata(bytes) : {};
            // Reject malformed/test APKs before creating a release row, leaving no empty release behind.
            if (kind === "apk" && !metadata.packageName) continue;
            validAssets.push({asset,kind,bytes,metadata});
          }
          if (!validAssets.length) continue;
          const row = await ensureRelease(id, name, name, release.name || name, release.published_at || release.created_at);
          for (const item of validAssets) {
            const {asset,kind,bytes,metadata,digest} = item;
            if (kind === "exe" && !repo.private && Number(asset.size || 0) > 50 * 1024 * 1024 && digest) {
              const payload = { release_id: row.id, platform: "windows", kind, filename: String(asset.name), download_url: asset.browser_download_url,
                size_bytes: Number(asset.size), sha256: digest, package_identity: `github:${repo.full_name}`, signing_status: "ready" };
              const prior = await sb.from("artifacts").select("id").eq("release_id", row.id).eq("filename", String(asset.name)).maybeSingle();
              const result = prior.data ? await sb.from("artifacts").update(payload).eq("id", prior.data.id) : await sb.from("artifacts").insert(payload);
              if (result.error) throw result.error;
              totals.artifacts++;
            } else if (bytes) {
              await save(row, String(asset.name), bytes, kind, `${repo.full_name}/${safeName(name)}/${safeName(String(asset.name))}`, metadata);
            }
          }
        }
        for (const file of sourceFiles) {
          const id = `github-file-${file.sha}`;
          const exists = await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", id).maybeSingle();
          if (exists.data) continue;
          const path = String(file.path), kind = artifactKind(path)!;
          const response = await fetch(`https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch || "main"}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers });
          if (!response.ok) continue;
          const bytes = new Uint8Array(await response.arrayBuffer());
          const metadata = kind === "apk" ? await apkMetadata(bytes) : {};
          if (kind === "apk" && !metadata.packageName) continue;
          const created = await ensureRelease(id, "Repository binary", "development", path, new Date().toISOString());
          await save(created, path.split("/").pop() || `application.${kind}`, bytes, kind,
            `${repo.full_name}/source/${file.sha}/${safeName(path.split("/").pop() || "application")}`, metadata);
        }
        for (const run of actionRuns) {
          const items = await gh(`${GH}/repos/${repo.full_name}/actions/runs/${run.id}/artifacts?per_page=20&direction=desc`, headers).catch(() => ({ artifacts: [] }));
          for (const item of (items.artifacts || []).filter((x: any) => !x.expired && /(apk|android|build|release|windows|exe)/i.test(String(x.name))).slice(0, 1)) {
            const id = `github-actions-artifact-${item.id}`;
            const exists = await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", id).maybeSingle();
            if (exists.data) continue;
            const response = await fetch(item.archive_download_url, { headers });
            if (!response.ok || Number(item.size_in_bytes || 0) > 80 * 1024 * 1024 || Number(response.headers.get("content-length") || 0) > 100 * 1024 * 1024) continue;
            const binaries = await archiveBinaries(new Uint8Array(await response.arrayBuffer()));
            if (!binaries.length) continue;
            const row = await ensureRelease(id, `workflow-${run.run_number || run.id}`, String(item.name), String(item.name), run.updated_at || run.created_at);
            for (const binary of binaries) {
              const kind = artifactKind(binary.name); if (kind && binary.bytes.byteLength <= 50 * 1024 * 1024) await save(row, binary.name, binary.bytes, kind,
                `${repo.full_name}/actions/${item.id}/${safeName(binary.name)}`, binary);
            }
          }
        }
        await retainCurrentAndPreviousApks(sb, Number(app.id));
      } catch (error) {
        totals.failures++;
        const issue = error as any;
        const detail = `${repo.full_name}: ${issue?.message || JSON.stringify(issue) || String(error)}`;
        failureDetails.push(detail.slice(0, 500));
        console.error("Repository discovery failed", detail);
      } finally {
        const progress = startIndex + repoOffset + 1;
        await sb.from("source_sync_state").update({
          status: "running", repositories_scanned: progress,
          applications_discovered: totals.applications, releases_discovered: totals.releases,
          artifacts_discovered: totals.artifacts, updated_at: new Date().toISOString(),
        }).eq("provider", "github");
      }
    }
    const finished = new Date().toISOString();
    const nextIndex = Math.min(startIndex + batchRepositories.length, repositories.length);
    const complete = nextIndex >= repositories.length;
    const status = complete ? (totals.failures ? "partial" : "success") : "running";
    const error = failureDetails.length ? failureDetails.join("; ").slice(0, 4000) : null;
    const stateWrite = await sb.from("source_sync_state").upsert({
      provider: "github", status, last_started_at: complete ? started.toISOString() : finished,
      last_success_at: complete ? finished : state?.last_success_at || null,
      last_error: error, repositories_scanned: complete ? repositories.length : nextIndex,
      applications_discovered: totals.applications, releases_discovered: totals.releases,
      artifacts_discovered: totals.artifacts, updated_at: finished,
    }, { onConflict: "provider" });
    if (stateWrite.error) return json({ ok: false, error: `Could not save sync status: ${stateWrite.error.message}`, scanned: repositories.length });
    return json({ ok: true, partial: totals.failures > 0, scan_complete: complete, cursor: complete ? 0 : nextIndex,
      authenticated_as: user.login, scanned: repositories.length, processed: batchRepositories.length,
      failed_repositories: totals.failures, failure_details: failureDetails, discovered: totals.applications,
      releases: totals.releases, artifacts: totals.artifacts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sb.from("source_sync_state").upsert({ provider: "github", status: "failed", last_error: message, updated_at: new Date().toISOString() }, { onConflict: "provider" });
    return json({ error: message }, 500);
  }
});
