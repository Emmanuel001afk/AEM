import { createClient } from "npm:@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-github-token"
};

const GH = "https://api.github.com";
const kinds = [".apk", ".apks", ".xapk", ".apkm"];

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function artifactKind(name: string) {
  const n = name.toLowerCase();
  if (n.endsWith(".apk")) return "apk";
  if (n.endsWith(".apks")) return "apks";
  if (n.endsWith(".xapk")) return "xapk";
  if (n.endsWith(".apkm")) return "apkm";
  return null;
}

function releaseChannel(rel: any): "stable" | "beta" | "development" {
  const t = String(rel.tag_name || rel.name || "").toLowerCase();
  if (rel.prerelease || /(^|[-_.])(beta|b)([-_.]|\d|$)/.test(t)) return "beta";
  if (/(^|[-_.])(dev|development|nightly|alpha|canary)([-_.]|\d|$)/.test(t)) return "development";
  return "stable";
}

function hasAndroidRoot(contents: any[]) {
  return contents.some((x: any) =>
    ["gradlew", "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"].includes(x.name)
  );
}

function hasWebRoot(contents: any[]) {
  return contents.some((x: any) =>
    ["capacitor.config.json", "capacitor.config.ts", "package.json", "vite.config.ts"].includes(x.name)
  );
}

function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function adminClient() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  const keys = JSON.parse(raw);
  const key = keys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Supabase server key unavailable");
  return createClient(Deno.env.get("SUPABASE_URL")!, key);
}

async function ghJson(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for ${url}`);
  return r.json();
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function syncWorkflowArtifacts(full: string, gh: Record<string, string>, app: any, sb: any) {
  let discovered = 0;
  const runsResponse = await fetch(
    `${GH}/repos/${full}/actions/runs?status=success&per_page=10`,
    { headers: gh }
  );
  if (!runsResponse.ok) return 0;
  const runsBody = await runsResponse.json();
  for (const run of (runsBody.workflow_runs || []).slice(0, 10)) {
    const existingRun = await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", `github-actions-${run.id}`).maybeSingle();
    if (existingRun.data) continue;

    const artifactsResponse = await fetch(
      `${GH}/repos/${full}/actions/runs/${run.id}/artifacts?per_page=50&direction=desc`,
      { headers: gh }
    );
    if (!artifactsResponse.ok) continue;
    const artifactsBody = await artifactsResponse.json();

    for (const workflowArtifact of (artifactsBody.artifacts || [])) {
      if (workflowArtifact.expired) continue;
      const artifactName = String(workflowArtifact.name || "");
      if (!/(apk|android|build|release)/i.test(artifactName)) continue;

      const sourceReleaseId = `github-actions-artifact-${workflowArtifact.id}`;
      const existing = await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", sourceReleaseId).maybeSingle();
      if (existing.data) continue;

      try {
        const archive = await fetch(workflowArtifact.archive_download_url, { headers: gh });
        if (!archive.ok) continue;
        const zip = await JSZip.loadAsync(await archive.arrayBuffer());
        const files = Object.values(zip.files).filter((entry: any) => {
          if (entry.dir) return false;
          const n = String(entry.name).toLowerCase();
          return kinds.some((k) => n.endsWith(k));
        }).slice(0, 20);
        if (!files.length) continue;

        const created = await sb.from("releases").insert({
          application_id: app.id,
          source_release_id: sourceReleaseId,
          version_name: `workflow-${run.run_number || run.id}`,
          version_code: Number(run.run_number || 0) || null,
          channel: "development",
          status: "published",
          title: artifactName,
          notes: `APK package discovered from GitHub Actions workflow run ${run.id}.`,
          published_at: run.updated_at || run.created_at
        }).select("id").single();
        if (created.error) throw created.error;

        for (const entry of files as any[]) {
          const bytes = await entry.async("uint8array");
          const filename = String(entry.name).split("/").pop() || "application.apk";
          const kind = artifactKind(filename);
          if (!kind || !bytes.length) continue;
          const digest = await sha256(bytes);
          const storagePath = `${full}/actions/${workflowArtifact.id}/${safeName(filename)}`;
          const upload = await sb.storage.from("aem-artifacts").upload(storagePath, bytes, {
            contentType: kind === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream",
            upsert: true
          });
          if (upload.error) throw upload.error;

          const url = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${storagePath}`;
          const inserted = await sb.from("artifacts").insert({
            release_id: created.data.id,
            platform: "android",
            kind,
            filename,
            download_url: url,
            size_bytes: bytes.byteLength,
            sha256: digest,
            package_identity: app.package_identity || null,
            version_code: Number(run.run_number || 0) || null
          });
          if (inserted.error) throw inserted.error;
          discovered++;
        }
      } catch (_) {
        // One malformed/expired workflow artifact must not block discovery of the remaining repositories.
      }
    }
  }
  return discovered;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const started = new Date().toISOString();
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const token = (req.headers.get("x-github-token") || String(body.github_token || "") || Deno.env.get("GITHUB_TOKEN") || "").trim();

    if (!token) {
      return json({
        error: "GitHub credential is not configured for this sync call.",
        code: "GITHUB_CREDENTIAL_MISSING"
      }, 503);
    }

    const gh = {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const who = await ghJson(`${GH}/user`, gh);
    const owner = String(who.login || "");
    const sb = adminClient();
    await sb.from("source_sync_state").upsert({
      provider: "github",
      status: "running",
      last_started_at: started,
      last_error: null,
      updated_at: started
    }, { onConflict: "provider" });

    const repos: any[] = [];
    for (let page = 1; ; page++) {
      const rows = await ghJson(
        `${GH}/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`,
        gh
      );
      if (!Array.isArray(rows) || rows.length === 0) break;
      repos.push(...rows);
      if (rows.length < 100) break;
    }

    let applicationsDiscovered = 0;
    let releasesDiscovered = 0;
    let artifactsDiscovered = 0;
    let queued = 0;

    for (const repo of repos) {
      const full = String(repo.full_name);
      const contentsResponse = await fetch(`${GH}/repos/${full}/contents/`, { headers: gh });
      if (!contentsResponse.ok) continue;
      const contents = await contentsResponse.json();

      const android = hasAndroidRoot(contents);
      const web = hasWebRoot(contents);

      let tree: any = { tree: [] };
      const treeResponse = await fetch(
        `${GH}/repos/${full}/git/trees/${repo.default_branch || "main"}?recursive=1`,
        { headers: gh }
      );
      if (treeResponse.ok) tree = await treeResponse.json();

      const apkFiles = (tree.tree || []).filter(
        (x: any) => x.type === "blob" && kinds.some((k) => String(x.path).toLowerCase().endsWith(k))
      );

      const releasesResponse = await fetch(`${GH}/repos/${full}/releases?per_page=30`, { headers: gh });
      const releases = releasesResponse.ok ? await releasesResponse.json() : [];
      const apkReleases = Array.isArray(releases)
        ? releases.filter((r: any) => Array.isArray(r.assets) && r.assets.some((a: any) => artifactKind(a.name)))
        : [];

      if (!android && !web && apkReleases.length === 0 && apkFiles.length === 0) continue;

      const externalId = String(repo.id);
      let { data: app } = await sb
        .from("applications")
        .select("id,provider,project,name,package_identity")
        .eq("provider", "github")
        .eq("source_external_id", externalId)
        .maybeSingle();

      if (!app) {
        const byProject = await sb
          .from("applications")
          .select("id,provider,project,name,package_identity")
          .eq("provider", "github")
          .eq("project", full)
          .maybeSingle();
        app = byProject.data || null;
      }

\n      const appPatch = {
        provider: "github",
        project: full,
        source_external_id: externalId,
        source_visibility: repo.private ? "private" : "public",
        name: String(repo.name),
        description: repo.description || null,
        source_url: repo.html_url,
        icon_url: repo.owner?.avatar_url || null,
        platforms: android ? (web ? ["android", "web"] : ["android"]) : ["web"],
        updated_at: new Date().toISOString()
      };

      // Prefer an application icon from the repository over the GitHub account avatar.
      const iconCandidate = (tree.tree || []).find((x: any) => x.type === "blob" && /(^|\/)(icon|logo|ic_launcher)([-_a-z0-9]*)\.(png|webp|jpg|jpeg)$/i.test(String(x.path)));
      if (iconCandidate) {
        appPatch.icon_url = `https://raw.githubusercontent.com/${full}/${repo.default_branch || "main"}/${String(iconCandidate.path).split("/").map(encodeURIComponent).join("/")}`;
      }

      if (!app) {
        const created = await sb.from("applications").insert(appPatch).select("id").single();
        if (created.error) throw created.error;
        app = { id: created.data.id };
        applicationsDiscovered++;
      } else {
        const updated = await sb.from("applications").update(appPatch).eq("id", app.id).select("id").single();
        if (updated.error) throw updated.error;
      }

      for (const rel of apkReleases) {
        const sourceReleaseId = `github-release-${rel.id}`;
        let release = (await sb.from("releases").select("id").eq("application_id", app.id).eq("source_release_id", sourceReleaseId).maybeSingle()).data;

        if (!release) {
          const created = await sb.from("releases").insert({
            application_id: app.id,
            source_release_id: sourceReleaseId,
            version_name: String(rel.tag_name || rel.name || "unknown"),
            version_code: null,
            channel: releaseChannel(rel),
            status: rel.draft ? "draft" : "published",
            title: rel.name || rel.tag_name || "GitHub release",
            notes: rel.body || null,
            published_at: rel.published_at || rel.created_at
          }).select("id").single();
          if (created.error) throw created.error;
          release = created.data;
          releasesDiscovered++;
        }

        const existingArtifacts = await sb.from("artifacts").select("id,filename").eq("release_id", release.id);
        const existingNames = new Set((existingArtifacts.data || []).map((x: any) => x.filename));

        for (const asset of (rel.assets || []).filter((a: any) => artifactKind(a.name))) {
          const kind = artifactKind(asset.name)!;
          if (existingNames.has(asset.name)) continue;

          const file = await fetch(asset.browser_download_url, { headers: gh });
          if (!file.ok) continue;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const digest = await sha256(bytes);
          const path = `${full}/${safeName(String(rel.tag_name || rel.id))}/${safeName(asset.name)}`;

          const upload = await sb.storage.from("aem-artifacts").upload(path, bytes, {
            contentType: kind === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream",
            upsert: true
          });
          if (upload.error) throw upload.error;

          const url = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`;
          const inserted = await sb.from("artifacts").insert({
            release_id: release.id,
            platform: "android",
            kind,
            filename: asset.name,
            download_url: url,
            size_bytes: bytes.byteLength,
            sha256: digest,
            package_identity: app.package_identity || null
          });
          if (inserted.error) throw inserted.error;
          artifactsDiscovered++;
        }
      }

      if (apkFiles.length) {
        for (const file of apkFiles.slice(0, 20)) {
          const sourceReleaseId = `github-file-${file.sha}`;
          const existingRelease = await sb
            .from("releases")
            .select("id")
            .eq("application_id", app.id)
            .eq("source_release_id", sourceReleaseId)
            .maybeSingle();
          if (existingRelease.data) continue;

          const kind = artifactKind(String(file.path));
          if (!kind) continue;

          const rawUrl = `https://raw.githubusercontent.com/${full}/${repo.default_branch || "main"}/${String(file.path).split("/").map(encodeURIComponent).join("/")}`;
          const fileResponse = await fetch(rawUrl, { headers: gh });
          if (!fileResponse.ok) continue;

          const bytes = new Uint8Array(await fileResponse.arrayBuffer());
          const digest = await sha256(bytes);
          const filename = String(file.path).split("/").pop() || "application.apk";
          const versionName = "Version metadata unavailable";
          const created = await sb.from("releases").insert({
            application_id: app.id,
            source_release_id: sourceReleaseId,
            version_name: versionName,
            version_code: null,
            channel: "development",
            status: "published",
            title: String(file.path),
            notes: "APK discovered directly in the GitHub repository. Android metadata is not exposed by the GitHub API.",
            published_at: new Date().toISOString()
          }).select("id").single();
          if (created.error) throw created.error;

          const storagePath = `${full}/source/${file.sha}/${safeName(filename)}`;
          const upload = await sb.storage.from("aem-artifacts").upload(storagePath, bytes, {
            contentType: kind === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream",
            upsert: true
          });
          if (upload.error) throw upload.error;

          const url = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${storagePath}`;
          const inserted = await sb.from("artifacts").insert({
            release_id: created.data.id,
            platform: "android",
            kind,
            filename,
            download_url: url,
            size_bytes: bytes.byteLength,
            sha256: digest,
            package_identity: app.package_identity || null
          });
          if (inserted.error) throw inserted.error;
          releasesDiscovered++;
          artifactsDiscovered++;
        }
      }

      await syncWorkflowArtifacts(full, gh, app, sb).then((n) => { artifactsDiscovered += n; }).catch(() => {});

      const androidArtifactCount = await sb
        .from("artifacts")
        .select("id,releases!inner(application_id)", { count: "exact", head: true })
        .eq("releases.application_id", app.id)
        .eq("platform", "android");

      if (android && (!app.package_identity || (androidArtifactCount.count || 0) === 0)) {
        const pending = await sb
          .from("build_requests")
          .select("id")
          .eq("repository", full)
          .in("status", ["queued", "running"])
          .limit(1);

        if (!pending.data?.length) {
          const created = await sb.from("build_requests").insert({
            repository: full,
            ref: repo.default_branch || "main",
            source_kind: "github",
            variant: "debug",
            channel: "development",
            application_id: app.id
          });
          if (created.error) throw created.error;
          queued++;
        }
      }
    }

    const finished = new Date().toISOString();
    await sb.from("source_sync_state").upsert({
      provider: "github",
      status: "success",
      last_started_at: started,
      last_success_at: finished,
      last_error: null,
      repositories_scanned: repos.length,
      applications_discovered: applicationsDiscovered,
      releases_discovered: releasesDiscovered,
      artifacts_discovered: artifactsDiscovered,
      updated_at: finished
    }, { onConflict: "provider" });

    return json({
      ok: true,
      provider: "github",
      authenticated_as: owner,
      scanned: repos.length,
      discovered: applicationsDiscovered,
      releases: releasesDiscovered,
      artifacts: artifactsDiscovered,
      queued
    });
  } catch (e) {
    try {
      const sb = adminClient();
      await sb.from("source_sync_state").upsert({
        provider: "github",
        status: "failed",
        last_error: e instanceof Error ? e.message : String(e),
        updated_at: new Date().toISOString()
      }, { onConflict: "provider" });
    } catch (_) {}
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
