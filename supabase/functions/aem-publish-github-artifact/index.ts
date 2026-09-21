import { ZipReader, BlobReader, BlobWriter } from "npm:@zip.js/zip.js@2.7.57";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-github-token"
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function supabaseAdmin() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  const keys = JSON.parse(raw);
  const key = keys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Supabase server key unavailable");
  return createClient(Deno.env.get("SUPABASE_URL")!, key);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const githubToken = req.headers.get("x-github-token")?.trim();
    if (!githubToken) return json({ error: "Missing GitHub credential" }, 401);

    const b = await req.json();
    const repo = String(b.repo || "").trim();
    const runId = Number(b.run_id);
    const artifactName = String(b.artifact_name || "").trim();
    const appProject = String(b.app_project || repo).trim();
    const requestId = String(b.request_id || "").trim();

    if (!repo || !Number.isFinite(runId) || runId <= 0 || !artifactName) {
      return json({ error: "Missing publish metadata" }, 400);
    }

    const gh = {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const access = await fetch(`https://api.github.com/repos/${repo}`, { headers: gh });
    if (!access.ok) return json({ error: `GitHub repository access failed: ${access.status}` }, 403);

    const list = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
      { headers: gh }
    );
    if (!list.ok) {
      const detail = await list.text().catch(() => "");
      return json({ error: `GitHub artifact lookup failed: ${list.status}`, detail: detail.slice(0, 500) }, 502);
    }

    const data = await list.json();
    const artifact = data.artifacts?.find((x: any) => x.name === artifactName && !x.expired);
    if (!artifact) return json({ error: "Build artifact not found" }, 404);

    const zipResponse = await fetch(artifact.archive_download_url, { headers: gh });
    if (!zipResponse.ok) {
      const detail = await zipResponse.text().catch(() => "");
      return json({ error: `GitHub artifact download failed: ${zipResponse.status}`, detail: detail.slice(0, 500) }, 502);
    }

    const reader = new ZipReader(new BlobReader(await zipResponse.blob()));
    const entries = await reader.getEntries();
    const apk = entries.find((e: any) => e.filename.toLowerCase().endsWith(".apk"));
    if (!apk || !apk.getData) {
      await reader.close();
      return json({ error: "No APK inside build artifact" }, 422);
    }

    const blob = await apk.getData(new BlobWriter());
    await reader.close();

    const sb = supabaseAdmin();
    const { data: app, error: appErr } = await sb
      .from("applications")
      .select("id,provider,project,name")
      .eq("provider", "github")
      .eq("project", appProject)
      .maybeSingle();

    if (appErr) throw appErr;
    if (!app) return json({ error: `AEM application is not registered for ${appProject}` }, 404);

    const versionName = String(b.version_name || "unknown");
    const versionCode = Number.isFinite(Number(b.version_code)) ? Number(b.version_code) : null;
    const channel = ["stable", "beta", "development"].includes(String(b.channel))
      ? String(b.channel)
      : "development";
    const sourceReleaseId = String(
      b.source_release_id || `github-actions-${repo.replaceAll("/", "-")}-${runId}`
    );

    const applicationPatch: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };
    if (b.application_name) applicationPatch.name = String(b.application_name);
    if (b.package_identity) applicationPatch.package_identity = String(b.package_identity);
    await sb.from("applications").update(applicationPatch).eq("id", app.id);

    let { data: release, error: releaseErr } = await sb
      .from("releases")
      .select("id")
      .eq("application_id", app.id)
      .eq("source_release_id", sourceReleaseId)
      .maybeSingle();

    if (releaseErr) throw releaseErr;

    if (!release) {
      const created = await sb.from("releases").insert({
        application_id: app.id,
        source_release_id: sourceReleaseId,
        version_name: versionName,
        version_code: versionCode,
        channel,
        status: "published",
        title: String(b.title || "AEM APK"),
        notes: b.notes ? String(b.notes) : null,
        published_at: new Date().toISOString()
      }).select("id").single();
      if (created.error) throw created.error;
      release = created.data;
    }

    const existingArtifact = await sb
      .from("artifacts")
      .select("id,download_url")
      .eq("release_id", release.id)
      .eq("filename", (apk.filename.split("/").pop() || "app.apk"))
      .maybeSingle();

    if (existingArtifact.error) throw existingArtifact.error;
    if (existingArtifact.data) {
      if (requestId) {
        await sb.from("build_requests").update({
          status: "succeeded",
          workflow_run_id: runId,
          application_id: app.id,
          release_id: release.id,
          artifact_id: existingArtifact.data.id,
          error: null,
          updated_at: new Date().toISOString()
        }).eq("id", requestId);
      }
      return json({
        ok: true,
        duplicate: true,
        release_id: release.id,
        artifact_id: existingArtifact.data.id,
        download_url: existingArtifact.data.download_url
      });
    }

    const filename = apk.filename.split("/").pop() || "app.apk";
    const safeSource = sourceReleaseId.replace(/[^A-Za-z0-9._-]/g, "_");
    const safeVersion = versionName.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = `${repo}/${safeVersion}/${safeSource}/${filename}`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha = Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");

    const up = await sb.storage.from("aem-artifacts").upload(path, bytes, {
      contentType: "application/vnd.android.package-archive",
      upsert: true
    });
    if (up.error) throw up.error;

    const url = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/aem-artifacts/${path}`;
    const inserted = await sb.from("artifacts").insert({
      release_id: release.id,
      platform: "android",
      kind: "apk",
      filename,
      download_url: url,
      size_bytes: bytes.byteLength,
      sha256: sha,
      package_identity: b.package_identity ? String(b.package_identity) : null,
      version_code: versionCode
    }).select("id").single();
    if (inserted.error) throw inserted.error;

    if (requestId) {
      await sb.from("build_requests").update({
        status: "succeeded",
        workflow_run_id: runId,
        application_id: app.id,
        release_id: release.id,
        artifact_id: inserted.data.id,
        error: null,
        updated_at: new Date().toISOString()
      }).eq("id", requestId);
    }

    return json({
      ok: true,
      release_id: release.id,
      artifact_id: inserted.data.id,
      download_url: url
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
