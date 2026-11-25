import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6";
import { sha256 as sha256Hash } from "npm:@noble/hashes@1.8.0/sha256";
import { bytesToHex } from "npm:@noble/hashes@1.8.0/utils";

const PROJECT_URL = "https://zaaauldrktvytskerpmc.supabase.co";
const OIDC_AUDIENCE = `${PROJECT_URL}/functions/v1/aem-publish-github-artifact`;
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PACKAGE_PATTERN = /^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const MAX_APK_BYTES = 500 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-github-token,x-aem-oidc,x-aem-repo,x-aem-request-id,x-aem-run-id,x-aem-artifact-name,x-aem-app-name,x-aem-version-name,x-aem-version-code,x-aem-channel,x-aem-package,x-aem-filename,x-aem-title,x-aem-source-release-id,x-aem-signing-cert",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function admin() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  const keys = JSON.parse(raw);
  const key = keys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Supabase server key unavailable");
  return createClient(Deno.env.get("SUPABASE_URL") || PROJECT_URL, key);
}

function clean(v: string) {
  return v.replace(/[^A-Za-z0-9._-]/g, "_");
}

function validateFilename(name: string): string | null {
  if (!name || name.length > 120 || /[\\/\x00-\x1f]/.test(name) || name === "." || name === ".." || name.includes("..")) {
    return null;
  }
  if (!/\.apk$/i.test(name)) return null;
  return name;
}

async function verifyCaller(req: Request, repo: string, channel: string): Promise<{ status?: number; error?: string }> {
  const oidcToken = (req.headers.get("x-aem-oidc") || "").trim();
  if (oidcToken) {
    try {
      const verified = await jwtVerify(oidcToken, GITHUB_JWKS, {
        issuer: GITHUB_ISSUER,
        audience: OIDC_AUDIENCE,
      });
      const claims = verified.payload as Record<string, unknown>;
      if (String(claims.repository || "").toLowerCase() !== repo.toLowerCase() || String(claims.repository_owner || "") !== "Emmanuel001afk") {
        return { status: 403, error: "GitHub OIDC claims do not match the target repository owned by Emmanuel001afk." };
      }
      if (channel === "stable") {
        const ref = String(claims.ref || "");
        if (ref !== "refs/heads/main" && !ref.startsWith("refs/tags/")) {
          return { status: 403, error: "Stable channel publishing requires a main branch or tag workflow ref." };
        }
      }
      return {};
    } catch (e) {
      return { status: 401, error: `GitHub OIDC verification failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const githubToken = (req.headers.get("x-github-token") || "").trim();
  if (!githubToken) {
    return { status: 401, error: "GitHub authorization (OIDC or push-scoped token) is required for publishing." };
  }
  const ghHeaders: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const repoCheck = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
  if (!repoCheck.ok) {
    return { status: 403, error: "GitHub authorization could not verify the requested repository." };
  }
  const repoInfo = await repoCheck.json();
  if (String(repoInfo?.owner?.login || "") !== "Emmanuel001afk") {
    return { status: 403, error: "Publishing is restricted to repositories owned by Emmanuel001afk." };
  }
  if (String(repoInfo?.full_name || "").toLowerCase() !== repo.toLowerCase()) {
    return { status: 403, error: "GitHub repository identity mismatch." };
  }
  const perms = repoInfo?.permissions || {};
  if (!perms.push && !perms.maintain && !perms.admin) {
    return { status: 403, error: "GitHub token lacks write/push permissions on the target repository." };
  }
  return {};
}

async function computeStreamDigest(url: string, maxBytes: number): Promise<{ bytes: number; sha256: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) {
    throw new Error(`Uploaded APK could not be read from Storage (HTTP ${res.status}).`);
  }
  const hasher = sha256Hash.create();
  let bytes = 0;
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Uploaded APK exceeds maximum size limit (${maxBytes} bytes).`);
      }
      hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, sha256: bytesToHex(hasher.digest()) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const ct = req.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      return json({ error: "Direct APK upload is no longer used; call prepare then upload directly to Storage, then finalize." }, 410);
    }
    const b = await req.json();
    const action = String(b.action || "");
    const repo = String(b.repo || "").trim();
    const runId = Number(b.run_id || 0);
    const rawFilename = String(b.filename || "app-release.apk").trim();
    const appName = String(b.application_name || "Application").trim().slice(0, 120);
    const versionName = String(b.version_name || "").trim();
    const vc = Number(b.version_code);
    const versionCode = Number.isInteger(vc) && vc >= 0 ? vc : null;
    const channel = ["stable", "beta", "development"].includes(String(b.channel)) ? String(b.channel) : "development";
    const packageIdentity = String(b.package_identity || "").trim();
    const title = String(b.title || "AEM APK").trim().slice(0, 200);
    const sourceReleaseId = String(b.source_release_id || `github-actions-${runId}`).trim();
    const signingCertificateSha256 = String(b.signing_certificate_sha256 || "").trim().replace(/:/g, "").toLowerCase();

    if (!REPO_PATTERN.test(repo)) {
      return json({ error: "Invalid GitHub repository format; expected owner/repo." }, 400);
    }
    const filename = validateFilename(rawFilename);
    if (!filename) {
      return json({ error: "Invalid APK filename." }, 400);
    }
    if (!Number.isInteger(runId) || runId <= 0 || versionCode === null || !versionName || !PACKAGE_PATTERN.test(packageIdentity)) {
      return json({ error: "Missing or invalid required publish metadata." }, 400);
    }
    if (!sourceReleaseId || sourceReleaseId.length > 160 || sourceReleaseId.includes("..") || /[\\/\x00-\x1f]/.test(sourceReleaseId)) {
      return json({ error: "Invalid source_release_id." }, 400);
    }
    if (signingCertificateSha256 && !HEX64_PATTERN.test(signingCertificateSha256)) {
      return json({ error: "Invalid signing_certificate_sha256; expected 64 hex characters." }, 400);
    }

    const auth = await verifyCaller(req, repo, channel);
    if (auth.error) return json({ error: auth.error }, auth.status || 403);

    const androidArtifactNeedsCentralSigning = !signingCertificateSha256;
    const sb = admin();
    const appRes = await sb.from("applications").select("id,package_identity").eq("provider", "github").eq("project", repo).maybeSingle();
    if (appRes.error) throw appRes.error;
    if (!appRes.data) return json({ error: `AEM application is not registered for ${repo}` }, 404);
    const appId = appRes.data.id;
    if (appRes.data.package_identity && appRes.data.package_identity !== packageIdentity) {
      return json({ error: `APK package identity ${packageIdentity} does not match catalog package ${appRes.data.package_identity}` }, 409);
    }

    const path = `${repo}/${clean(versionName)}/${clean(sourceReleaseId)}/${clean(filename)}`;
    const requestedObjectPath = String(b.object_path || b.path || path);
    if (requestedObjectPath !== path) {
      return json({ error: `Storage object path mismatch: expected ${path}, received ${requestedObjectPath}.` }, 409);
    }
    if (!path || path.startsWith("/") || path.includes("..")) {
      return json({ error: "Invalid Storage object path" }, 400);
    }

    const existingRelease = await sb.from("releases").select("id,version_name,version_code,channel,status").eq("application_id", appId).eq("source_release_id", sourceReleaseId).maybeSingle();
    if (existingRelease.error) throw existingRelease.error;
    const existingArtifact = existingRelease.data
      ? await sb.from("artifacts").select("id,download_url,size_bytes,sha256").eq("release_id", existingRelease.data.id).eq("filename", filename).maybeSingle()
      : null;
    if (existingArtifact?.error) throw existingArtifact.error;

    if (action === "prepare") {
      if (existingArtifact?.data) {
        return json({ error: `Artifact ${filename} for ${sourceReleaseId} is already finalized and cannot be overwritten.` }, 409);
      }
      const bucket = await sb.storage.getBucket("aem-artifacts");
      if (bucket.error) return json({ error: `AEM Storage bucket is unavailable: ${bucket.error.message}` }, 502);
      if (!bucket.data) return json({ error: "AEM Storage bucket aem-artifacts does not exist" }, 502);
      const up = await sb.storage.from("aem-artifacts").createSignedUploadUrl(path, { upsert: true });
      if (up.error) return json({ error: `Storage signed-upload preparation failed: ${up.error.message}` }, 502);
      const uploadUrl = String(up.data?.signedUrl || "");
      const token = String(up.data?.token || "");
      if (!uploadUrl || !token) return json({ error: "Storage did not return a valid signed upload URL" }, 502);
      return json({
        ok: true,
        path,
        storage_path: `aem-artifacts/${path}`,
        token,
        upload_url: uploadUrl,
        release_metadata: { repo, runId, filename, appName, versionName, versionCode, channel, packageIdentity, title, sourceReleaseId, signingCertificateSha256 },
      });
    }

    if (action !== "finalize") return json({ error: "Unknown action" }, 400);
    if (existingRelease.data && existingArtifact?.data) {
      return json({
        ok: true,
        duplicate: true,
        release_id: existingRelease.data.id,
        artifact_id: existingArtifact.data.id,
        download_url: existingArtifact.data.download_url,
        size_bytes: existingArtifact.data.size_bytes,
        sha256: existingArtifact.data.sha256,
      });
    }

    const latest = await sb.from("releases").select("version_code").eq("application_id", appId).eq("channel", channel).eq("status", "published").not("version_code", "is", null).order("version_code", { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw latest.error;
    if (latest.data && Number(versionCode) <= Number(latest.data.version_code || 0)) {
      return json({ error: `Refusing to publish version code ${versionCode}: latest published ${channel} version code is ${latest.data.version_code}.` }, 409);
    }

    const sizeBytes = Number(b.size_bytes || 0);
    const sha256 = String(b.sha256 || "").trim().toLowerCase();
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_APK_BYTES || !HEX64_PATTERN.test(sha256)) {
      return json({ error: "Missing or invalid uploaded artifact checksum/size." }, 400);
    }

    const signedRead = await sb.storage.from("aem-artifacts").createSignedUrl(path, 120);
    if (signedRead.error || !signedRead.data?.signedUrl) {
      return json({ error: `Uploaded APK was not found in AEM Storage: ${signedRead.error?.message || "missing object"}` }, 409);
    }
    const verified = await computeStreamDigest(signedRead.data.signedUrl, MAX_APK_BYTES);
    if (verified.bytes !== sizeBytes) {
      return json({ error: `Uploaded APK size mismatch: expected ${sizeBytes}, stored ${verified.bytes}.` }, 422);
    }
    if (verified.sha256 !== sha256) {
      return json({ error: `Uploaded APK SHA-256 mismatch: expected ${sha256}, stored ${verified.sha256}.` }, 422);
    }

    const objectUrl = `${Deno.env.get("SUPABASE_URL") || PROJECT_URL}/storage/v1/object/public/aem-artifacts/${path}`;
    let release = existingRelease.data;
    if (!release) {
      const created = await sb.from("releases").insert({
        application_id: appId,
        source_release_id: sourceReleaseId,
        version_name: versionName,
        version_code: versionCode,
        channel,
        status: "published",
        title,
        notes: null,
        published_at: new Date().toISOString(),
      }).select("id").single();
      if (created.error) throw created.error;
      release = created.data;
    }

    const existing = await sb.from("artifacts").select("id,download_url,size_bytes,sha256").eq("release_id", release.id).eq("filename", filename).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      return json({ ok: true, duplicate: true, release_id: release.id, artifact_id: existing.data.id, download_url: existing.data.download_url, size_bytes: existing.data.size_bytes, sha256: existing.data.sha256 });
    }

    const ins = await sb.from("artifacts").insert({
      release_id: release.id,
      platform: "android",
      kind: "apk",
      filename,
      download_url: objectUrl,
      size_bytes: sizeBytes,
      sha256,
      artifact_version_name: versionName,
      source_updated_at: new Date().toISOString(),
      package_identity: packageIdentity,
      signing_certificate_sha256: signingCertificateSha256 || null,
      signing_status: androidArtifactNeedsCentralSigning ? "pending" : "ready",
      version_code: versionCode,
    }).select("id").single();
    if (ins.error) throw ins.error;

    await sb.from("applications").update({ package_identity: packageIdentity, updated_at: new Date().toISOString() }).eq("id", appId);

    if (androidArtifactNeedsCentralSigning) {
      const dispatchToken = (Deno.env.get("AEM_GITHUB_DISPATCH_TOKEN") || "").trim();
      if (dispatchToken) {
        try {
          const dispatch = await fetch("https://api.github.com/repos/Emmanuel001afk/AEM/dispatches", {
            method: "POST",
            headers: {
              "Accept": "application/vnd.github+json",
              "Authorization": `Bearer ${dispatchToken}`,
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event_type: "aem-android-artifact-pending",
              client_payload: { source_repo: repo, source_release_id: sourceReleaseId, artifact_id: ins.data.id },
            }),
          });
          if (!dispatch.ok) console.error("AEM immediate signing dispatch failed", dispatch.status, await dispatch.text());
        } catch (dispatchError) {
          console.error("AEM immediate signing dispatch error", dispatchError);
        }
      } else {
        console.warn("AEM_GITHUB_DISPATCH_TOKEN is not configured; scheduler remains the signing safety net.");
      }
    }
    return json({ ok: true, release_id: release.id, artifact_id: ins.data.id, download_url: objectUrl, sha256, size_bytes: sizeBytes });
  } catch (e) {
    console.error("AEM publish error", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
