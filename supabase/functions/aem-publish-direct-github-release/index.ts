import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-aem-external-publish-secret",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const GH = "https://api.github.com";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function admin() {
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  const key = keys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Supabase server key unavailable");
  return createClient(Deno.env.get("SUPABASE_URL")!, key);
}
function clean(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}
function channel(value: string): "stable" | "beta" | "development" {
  const v = value.toLowerCase();
  if (/(^|[-_.])(beta|b)([-_.]|\d|$)/.test(v)) return "beta";
  if (/(^|[-_.])(dev|development|debug|nightly|alpha|canary)([-_.]|\d|$)/.test(v)) return "development";
  return "stable";
}
function isSha256(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const configuredSecret = (Deno.env.get("AEM_EXTERNAL_PUBLISH_SECRET") || "").trim();
    const suppliedSecret = (req.headers.get("x-aem-external-publish-secret") || "").trim();
    if (!configuredSecret || suppliedSecret.length < 32 || suppliedSecret !== configuredSecret) {
      return json({ error: "External publishing is not authorized." }, 401);
    }

    const body = await req.json();
    const repo = String(body.repo || "").trim();
    const tag = String(body.tag || "").trim();
    const filename = String(body.filename || "").trim();
    const downloadUrl = String(body.download_url || "").trim();
    const versionName = String(body.version_name || tag).trim();
    const versionCode = Number(body.version_code);
    const packageIdentity = String(body.package_identity || "").trim();
    const sha256 = String(body.sha256 || "").trim().toLowerCase();
    const sizeBytes = Number(body.size_bytes);
    const signingCertificateSha256 = String(body.signing_certificate_sha256 || "").replace(/:/g, "").trim().toLowerCase();
    const title = String(body.title || versionName).trim();
    const notes = body.notes == null ? null : String(body.notes).slice(0, 20000);
    const publishChannel = channel(String(body.channel || tag));

    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return json({ error: "repo must be in owner/repository format." }, 400);
    if (!tag || tag.length > 200 || !/^[A-Za-z0-9._+-]+$/.test(tag)) return json({ error: "A valid GitHub release tag is required." }, 400);
    if (!filename || !/\.apk$/i.test(filename) || filename.length > 240) return json({ error: "A valid .apk filename is required." }, 400);
    if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || !packageIdentity || packageIdentity.length > 255) return json({ error: "Valid version_code and package_identity are required." }, 400);
    if (!isSha256(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return json({ error: "A SHA-256 checksum and positive size_bytes are required." }, 400);
    if (!isSha256(signingCertificateSha256)) return json({ error: "Provide the source APK signing certificate SHA-256; AEM will not claim an unverified signing identity." }, 400);

    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" ||
        parsed.pathname !== `/${repo}/releases/download/${tag}/${filename}`) {
      return json({ error: "download_url must be the exact HTTPS GitHub Releases asset URL for the supplied repository, tag and filename." }, 400);
    }

    const githubToken = (Deno.env.get("AEM_GITHUB_TOKEN") || Deno.env.get("GITHUB_TOKEN") || "").trim();
    if (!githubToken) return json({ error: "AEM_GITHUB_TOKEN is not configured for release verification." }, 503);
    const ghHeaders = { "Accept": "application/vnd.github+json", "Authorization": `Bearer ${githubToken}`, "X-GitHub-Api-Version": "2022-11-28" };
    const releaseResponse = await fetch(`${GH}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: ghHeaders });
    if (!releaseResponse.ok) return json({ error: "GitHub could not verify that release tag." }, 422);
    const release = await releaseResponse.json();
    if (release.draft) return json({ error: "Draft GitHub releases cannot be distributed." }, 422);
    const asset = (release.assets || []).find((item: any) =>
      item.name === filename && item.browser_download_url === downloadUrl && Number(item.size) === sizeBytes);
    if (!asset) return json({ error: "The URL, filename and size do not match a published GitHub Release asset." }, 422);
    if (asset.digest && String(asset.digest).toLowerCase() !== `sha256:${sha256}`) {
      return json({ error: "SHA-256 does not match GitHub's published asset digest." }, 422);
    }

    const sb = admin();
    const appResult = await sb.from("applications").select("id,package_identity").eq("provider", "github").eq("project", repo).maybeSingle();
    if (appResult.error) throw appResult.error;
    if (!appResult.data) return json({ error: `AEM catalogue entry is not registered for ${repo} yet.` }, 404);
    if (appResult.data.package_identity && appResult.data.package_identity !== packageIdentity) {
      return json({ error: "APK package identity does not match the AEM catalogue entry." }, 409);
    }

    const sourceReleaseId = `github-direct-${asset.id}`;
    const existingReleaseResult = await sb.from("releases").select("id,version_code").eq("application_id", appResult.data.id).eq("source_release_id", sourceReleaseId).maybeSingle();
    if (existingReleaseResult.error) throw existingReleaseResult.error;
    let releaseRow = existingReleaseResult.data;
    if (!releaseRow) {
      const latest = await sb.from("releases").select("version_code").eq("application_id", appResult.data.id).eq("channel", publishChannel).eq("status", "published").not("version_code", "is", null).order("version_code", { ascending: false }).limit(1).maybeSingle();
      if (latest.error) throw latest.error;
      if (latest.data && versionCode <= Number(latest.data.version_code || 0)) {
        return json({ error: `Refusing version code ${versionCode}; latest published ${publishChannel} version code is ${latest.data.version_code}.` }, 409);
      }
      const inserted = await sb.from("releases").insert({
        application_id: appResult.data.id,
        source_release_id: sourceReleaseId,
        version_name: versionName,
        version_code: versionCode,
        channel: publishChannel,
        status: "published",
        title: title || versionName,
        notes,
        published_at: release.published_at || new Date().toISOString(),
      }).select("id").single();
      if (inserted.error) throw inserted.error;
      releaseRow = inserted.data;
    }

    const artifactPayload = {
      release_id: releaseRow.id,
      platform: "android",
      kind: "apk",
      filename,
      download_url: downloadUrl,
      size_bytes: sizeBytes,
      sha256,
      package_identity: packageIdentity,
      version_code: versionCode,
      signing_certificate_sha256: signingCertificateSha256,
      signing_status: "ready",
      signing_authority: "source",
      signing_error: null,
    };
    const existingArtifact = await sb.from("artifacts").select("id").eq("release_id", releaseRow.id).eq("filename", filename).maybeSingle();
    if (existingArtifact.error) throw existingArtifact.error;
    if (existingArtifact.data) {
      const updated = await sb.from("artifacts").update(artifactPayload).eq("id", existingArtifact.data.id);
      if (updated.error) throw updated.error;
    } else {
      const inserted = await sb.from("artifacts").insert(artifactPayload);
      if (inserted.error) throw inserted.error;
    }
    await sb.from("applications").update({ package_identity: packageIdentity, updated_at: new Date().toISOString() }).eq("id", appResult.data.id);

    return json({
      ok: true,
      distribution: "direct-github-release",
      storage_required: false,
      release_id: releaseRow.id,
      filename,
      download_url: downloadUrl,
      size_bytes: sizeBytes,
      sha256,
      signing_status: "ready",
      signing_authority: "source",
    });
  } catch (error) {
    console.error("AEM direct-source publish error", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
