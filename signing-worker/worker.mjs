import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const API = `${process.env.SUPABASE_URL}/functions/v1/aem-android-signing`;
const ANON_KEY = required("SUPABASE_PUBLISHABLE_KEY");
const WORKER_TOKEN = required("AEM_SIGNING_WORKER_TOKEN");
const KEYSTORE = path.resolve(process.env.AEM_KEYSTORE_PATH || "./aem-store-release.jks");
const KEY_ALIAS = required("AEM_STORE_KEY_ALIAS");
const KEYSTORE_PASSWORD = required("AEM_STORE_KEYSTORE_PASSWORD");
const KEY_PASSWORD = required("AEM_STORE_KEY_PASSWORD");
const APK_SIGNER = path.resolve(process.env.APK_SIGNER_PATH || "./android-sdk-build-tools/apksigner");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function api(action, body = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
      "x-aem-worker-token": WORKER_TOKEN,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${action} HTTP ${res.status}: ${text.slice(0, 1200)}`);
  return JSON.parse(text);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", b => { stdout += b; });
    child.stderr.on("data", b => { stderr += b; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1800)}`)));
  });
}

async function processArtifact(artifact) {
  const dir = path.resolve("./tmp");
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, `${artifact.id}-input.apk`);
  const output = path.join(dir, `${artifact.id}-signed.apk`);
  try {
    const download = await fetch(artifact.download_url);
    if (!download.ok) throw new Error(`APK download HTTP ${download.status}`);
    await writeFile(input, Buffer.from(await download.arrayBuffer()));
    await run(APK_SIGNER, ["sign", "--ks", KEYSTORE, "--ks-key-alias", KEY_ALIAS, "--ks-pass", `pass:${KEYSTORE_PASSWORD}`, "--key-pass", `pass:${KEY_PASSWORD}`, "--out", output, input]);
    const verified = await run(APK_SIGNER, ["verify", "--print-certs", output]);
    const certMatch = verified.stdout.match(/(?:SHA-256|SHA256).*?([0-9a-f]{64})/i) || verified.stderr.match(/(?:SHA-256|SHA256).*?([0-9a-f]{64})/i);
    const cert = certMatch?.[1]?.toLowerCase();
    if (!cert) throw new Error("Unable to extract signing certificate fingerprint");
    const prep = await api("prepare-upload", { artifact_id: artifact.id });
    const bytes = await readFile(output);
    const upload = await fetch(prep.upload_url, {
      method: "PUT",
      headers: {"Content-Type":"application/vnd.android.package-archive","Content-Length":String(bytes.length),"x-upsert":"true"},
      body: bytes,
    });
    if (!upload.ok) throw new Error(`Signed APK upload HTTP ${upload.status}: ${(await upload.text()).slice(0, 1000)}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    await api("complete", { artifact_id: artifact.id, signing_certificate_sha256: cert, sha256: sha, size_bytes: bytes.length });
    console.log(`Signed artifact ${artifact.id} (${artifact.filename})`);
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}

async function main() {
  await stat(KEYSTORE);
  await stat(APK_SIGNER);
  const queue = await api("claim", { limit: 25 });
  console.log(`Claimed ${queue.artifacts.length} Android APK(s).`);
  for (const artifact of queue.artifacts) {
    try { await processArtifact(artifact); }
    catch (error) {
      console.error(`Artifact ${artifact.id} failed:`, error);
      try { await api("fail", { artifact_id: artifact.id, error: String(error).slice(0, 1800) }); } catch (e) { console.error("Failed to reset artifact:", e); }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
