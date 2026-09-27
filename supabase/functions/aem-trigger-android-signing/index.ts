import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PROJECT_URL = "https://wfvvmyixqcwosmuldxoq.supabase.co";
const REPO = "Emmanuel001afk/AEM";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-aem-sync-secret",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function db() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  const key = JSON.parse(raw).default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Supabase server key unavailable");
  return createClient(Deno.env.get("SUPABASE_URL") || PROJECT_URL, key);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const sb = db();
    const supplied = String(req.headers.get("x-aem-sync-secret") || "").trim();
    const secret = await sb.rpc("aem_get_sync_secret");
    if (secret.error || !secret.data || supplied !== String(secret.data)) {
      return json({ ok: false, error: "Unauthorized trigger caller." }, 401);
    }

    const token = (Deno.env.get("AEM_GITHUB_TOKEN") || Deno.env.get("GITHUB_TOKEN") || "").trim();
    if (!token) return json({ ok: false, error: "GitHub token is not configured." }, 503);

    const body = await req.json().catch(() => ({}));
    const artifactId = Number(body.artifact_id || 0) || null;

    const response = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "aem-android-artifact-pending",
        client_payload: {
          source: "aem-database-trigger",
          artifact_id: artifactId,
        },
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1200);
      return json({ ok: false, error: `GitHub repository_dispatch HTTP ${response.status}: ${detail}` }, 502);
    }

    return json({ ok: true, dispatched: true, artifact_id: artifactId });
  } catch (e) {
    console.error("AEM signing trigger error", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
