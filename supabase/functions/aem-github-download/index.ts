import {createClient} from "npm:@supabase/supabase-js@2";

// Public intentionally: the owner has chosen to make catalogued binaries from
// private repositories downloadable. Never return the GitHub token itself.
const cors = {"Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"GET,HEAD,OPTIONS", "Access-Control-Allow-Headers":"Range"};
const fail = (message:string,status:number) => new Response(message,{status,headers:{...cors,"Cache-Control":"no-store"}});
const repoPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sourcePattern=/^(?:release_asset|actions_artifact)$/;

Deno.serve(async (req:Request) => {
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers:cors});
  if (req.method !== "GET" && req.method !== "HEAD") return fail("Method not allowed",405);
  const id=new URL(req.url).searchParams.get("id") || "";
  if (!/^[1-9][0-9]{0,15}$/.test(id)) return fail("Invalid download",400);
  try {
    const key=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const token=Deno.env.get("AEM_GITHUB_TOKEN");
    if (!key || !token) return fail("Download service unavailable",503);
    const sb=createClient(Deno.env.get("SUPABASE_URL")!,key);
    const {data,error}=await sb.from("github_download_sources").select("repo,source_kind,github_id,expires_at,artifacts!inner(id,signing_status,releases!inner(status))").eq("artifact_id",id).maybeSingle();
    if (error) return fail("Download service unavailable",503);
    const artifact=Array.isArray(data?.artifacts)?data.artifacts[0]:data?.artifacts;
    const release=Array.isArray(artifact?.releases)?artifact.releases[0]:artifact?.releases;
    if (!data || !artifact || release?.status!=="published" || artifact.signing_status!=="ready") return fail("Download not found",404);
    if (!repoPattern.test(String(data.repo)) || !sourcePattern.test(String(data.source_kind)) || !/^[1-9][0-9]*$/.test(String(data.github_id))) return fail("Download unavailable",503);
    if (data.expires_at && Date.parse(data.expires_at)<=Date.now()) return fail("Download has expired",410);
    const [owner,repo]=String(data.repo).split("/");
    const suffix=data.source_kind==="actions_artifact"?`actions/artifacts/${data.github_id}/zip`:`releases/assets/${data.github_id}`;
    const api=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${suffix}`;
    const response=await fetch(api,{redirect:"manual",headers:{"Accept":data.source_kind === "actions_artifact" ? "application/vnd.github+json" : "application/octet-stream","Authorization":`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"AEM-Store"}});
    const location=response.headers.get("location");
    // GitHub generates a short-lived URL to this particular object; no GitHub
    // Authorization header is ever sent to the target or exposed to clients.
    if (![301,302,303,307,308].includes(response.status) || !location) return fail(response.status===404||response.status===410?"Download unavailable or expired":`Download temporarily unavailable (source HTTP ${response.status})`,response.status===404||response.status===410?410:502);
    let target:URL;
    try { target=new URL(location); } catch { return fail("Invalid download destination",502); }
    if (target.protocol!=="https:" || target.username || target.password) return fail("Invalid download destination",502);
    return new Response(null,{status:302,headers:{...cors,"Cache-Control":"no-store","Referrer-Policy":"no-referrer","Location":target.toString()}});
  } catch { return fail("Download temporarily unavailable",503); }
});
