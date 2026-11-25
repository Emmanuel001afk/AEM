import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6";
import { sha256 as sha256Hash } from "npm:@noble/hashes@1.8.0/sha256";
import { bytesToHex } from "npm:@noble/hashes@1.8.0/utils";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-aem-oidc,x-aem-worker-token",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const PROJECT_URL = "https://zaaauldrktvytskerpmc.supabase.co";
const OIDC_AUDIENCE = `${PROJECT_URL}/functions/v1/aem-android-signing`;
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const MAX_SIGNED_APK_BYTES = 500 * 1024 * 1024;
const ALLOWED_SIGNING_WORKFLOWS = [
  "Emmanuel001afk/AEM/.github/workflows/aem-android-central-signing.yml@",
  "Emmanuel001afk/AEM/.github/workflows/aem-android-central-signing-v2.yml@",
];

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

async function authorizeWorker(sb: ReturnType<typeof admin>, req: Request) {
  const token = String(req.headers.get("x-aem-worker-token") || "").trim();
  if (!token) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const { data, error } = await sb.from("aem_signing_worker_auth").select("id").eq("token_sha256", hash).eq("enabled", true).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function authorizeWorkflow(req: Request) {
  const token = String(req.headers.get("x-aem-oidc") || "").trim();
  if (!token) throw new Error("GitHub Actions OIDC token is required.");
  const verified = await jwtVerify(token, GITHUB_JWKS, {
    issuer: GITHUB_ISSUER,
    audience: OIDC_AUDIENCE,
  });
  const claims = verified.payload as Record<string, unknown>;
  if (claims.repository !== "Emmanuel001afk/AEM" || claims.repository_owner !== "Emmanuel001afk") {
    throw new Error("Signing is restricted to the AEM repository.");
  }
  if (claims.ref !== "refs/heads/main") {
    throw new Error("Signing workflow must run from refs/heads/main.");
  }
  const jobWorkflowRef = String(claims.job_workflow_ref || "");
  if (!ALLOWED_SIGNING_WORKFLOWS.some((prefix) => jobWorkflowRef.startsWith(prefix))) {
    throw new Error("Signing is restricted to the central Android signing workflow.");
  }
  return claims;
}

function storagePath(downloadUrl: string) {
  const marker = "/storage/v1/object/public/aem-artifacts/";
  const i = downloadUrl.indexOf(marker);
  if (i < 0) throw new Error("Artifact storage path is not an AEM artifact.");
  const path = downloadUrl.slice(i + marker.length);
  if (!path || path.startsWith("/") || path.includes("..")) throw new Error("Invalid artifact storage path.");
  return path;
}

async function computeStreamDigest(url: string, maxBytes: number): Promise<{ bytes: number; sha256: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) {
    throw new Error(`Signed APK could not be read from Storage (HTTP ${res.status}).`);
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
        throw new Error(`Signed APK exceeds maximum size limit (${maxBytes} bytes).`);
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
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const sb = admin();
    const workerAuthorized = await authorizeWorker(sb, req);
    if (!workerAuthorized) await authorizeWorkflow(req);
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "claim") {
      const limit = Math.max(1, Math.min(25, Number(body.limit || 25)));
      const { data, error } = await sb.rpc("claim_android_artifacts", { claim_limit: limit });
      if (error) throw error;
      return json({
        artifacts: (data || []).map((a: any) => ({
          id: a.id,
          filename: a.filename,
          download_url: a.download_url,
          package_identity: a.package_identity,
          version_code: a.version_code,
          sha256: a.sha256,
          size_bytes: a.size_bytes,
        })),
      });
    }

    const id = Number(body.artifact_id || 0);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Valid artifact_id is required." }, 400);

    const current = await sb.from("artifacts")
      .select("id,platform,kind,signing_status,signing_authority,download_url,filename,package_identity,version_code")
      .eq("id", id).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return json({ error: "Artifact not found." }, 404);
    if (current.data.platform !== "android" || current.data.kind !== "apk") return json({ error: "Only Android APK artifacts can be centrally signed." }, 400);

    if (action === "prepare-upload") {
      if (current.data.signing_status !== "processing") return json({ error: "Artifact is not currently claimed for signing." }, 409);
      const path = storagePath(String(current.data.download_url || ""));
      const upload = await sb.storage.from("aem-artifacts").createSignedUploadUrl(path, { upsert: true });
      if (upload.error) return json({ error: upload.error.message }, 502);
      return json({ ok: true, path, upload_url: upload.data?.signedUrl, token: upload.data?.token });
    }

    if (action === "complete") {
      if (current.data.signing_status !== "processing") return json({ error: "Artifact is not currently claimed for signing." }, 409);
      const cert = String(body.signing_certificate_sha256 || "").replace(/:/g, "").toLowerCase();
      const sha = String(body.sha256 || "").toLowerCase();
      const size = Number(body.size_bytes || 0);
      if (!/^[0-9a-f]{64}$/.test(cert)) return json({ error: "Invalid signing certificate fingerprint." }, 400);
      if (!/^[0-9a-f]{64}$/.test(sha) || !Number.isInteger(size) || size <= 0 || size > MAX_SIGNED_APK_BYTES) {
        return json({ error: "Invalid signed artifact checksum or size." }, 400);
      }

      const path = storagePath(String(current.data.download_url || ""));
      const signedRead = await sb.storage.from("aem-artifacts").createSignedUrl(path, 120);
      if (signedRead.error || !signedRead.data?.signedUrl) {
        return json({ error: `Signed APK could not be located in Storage: ${signedRead.error?.message || "missing"}` }, 409);
      }
      const verified = await computeStreamDigest(signedRead.data.signedUrl, MAX_SIGNED_APK_BYTES);
      if (verified.bytes !== size) {
        return json({ error: `Signed APK size mismatch: expected ${size}, stored ${verified.bytes}.` }, 422);
      }
      if (verified.sha256 !== sha) {
        return json({ error: `Signed APK SHA-256 mismatch: expected ${sha}, stored ${verified.sha256}.` }, 422);
      }

      const updated = await sb.from("artifacts").update({
        signing_status: "ready",
        signing_authority: "aem",
        signing_error: null,
        signing_certificate_sha256: cert,
        sha256: sha,
        size_bytes: size,
      }).eq("id", id).eq("signing_status", "processing").select("id").single();
      if (updated.error) throw updated.error;
      return json({ ok: true, artifact_id: id, signing_authority: "aem", signing_certificate_sha256: cert, sha256: sha, size_bytes: size });
    }

    if (action === "fail") {
      await sb.from("artifacts").update({
        signing_status: "failed",
        signing_authority: "source",
        signing_error: String(body.error || "Central signing failed").slice(0, 2000),
      }).eq("id", id).eq("signing_status", "processing");
      return json({ ok: true, artifact_id: id, signing_status: "failed" });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("AEM Android signing error", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 401);
  }
});
