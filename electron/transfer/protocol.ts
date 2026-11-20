/** Wire primitives shared by AEM's local transfer channels.
 * `aem-lan/1` is the browser companion (electron/transfer/service.ts); `aem-peer/1` is desktop ↔
 * desktop pairing (electron/transfer/peer.ts). Neither channel accepts, forwards or trusts the
 * Android Wi-Fi Direct protocol 6 session tokens; they are separate versioned transports.
 */
import fs from 'fs';
import crypto from 'crypto';
import type {IncomingMessage, ServerResponse} from 'http';

/** Browser companion bounds: a phone browser is the weakest peer, so the limits are tight. */
export const LAN_CHUNK = 1024 * 1024;
export const LAN_MAX_FILE = 256 * 1024 * 1024;
export const LAN_MAX_TOTAL = 2 * 1024 ** 3;
/** Desktop ↔ desktop bounds: two paired AEM PCs, still bounded and never unlimited. */
export const PEER_CHUNK = 1024 * 1024;
export const PEER_MAX_FILE = 4 * 1024 ** 3;
export const PEER_MAX_TOTAL = 32 * 1024 ** 3;
export const FREE_RESERVE = 2 * 1024 ** 3;
export const JSON_LIMIT = 4096;

export const limitLabel = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 ? 1 : 0)} GiB` : `${Math.round(bytes / 1024 / 1024)} MiB`;

export const sha = (v: crypto.BinaryLike) => crypto.createHash('sha256').update(v).digest('hex');
export const randomId = () => crypto.randomBytes(16).toString('hex');
export const secret = () => crypto.randomBytes(32).toString('base64url');
/** Length-safe constant-time compare; never throws on short/odd input. */
export function equal(a: unknown, b: unknown) {
  const x = Buffer.from(sha(String(a ?? ''))), y = Buffer.from(sha(String(b ?? '')));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/** Node reports certificate fingerprints as colon-separated upper hex; comparisons normalize. */
export const normFp = (v: unknown) => String(v ?? '').replace(/:/g, '').toLowerCase();

export class HttpError extends Error {
  constructor(public status: number, message: string) {super(message);}
}

/** Windows-safe single-segment filename + declared size/hash bounds. Shared by both channels so the
 * receiver's acceptance criteria cannot drift apart between transports. */
export function validateManifest(v: any, maxFileBytes: number = LAN_MAX_FILE): {name: string; size: number; sha256: string} {
  if (!v || typeof v.name !== 'string' || v.name.length < 1 || v.name.length > 120 ||
      /[\\/<>:"|?*\x00-\x1f]/.test(v.name) || /[. ]$/.test(v.name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(v.name) || v.name === '.' || v.name === '..') {
    throw new HttpError(400, 'Unsafe filename');
  }
  if (!Number.isSafeInteger(v.size) || v.size < 0 || v.size > maxFileBytes ||
      typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)) {
    throw new HttpError(400, `Invalid size/hash; maximum file size is ${limitLabel(maxFileBytes)}`);
  }
  return {name: v.name, size: v.size, sha256: v.sha256};
}

/** Display-only peer labels are user-declared. Strip control/format characters so they cannot
 * spoof a native consent dialog. */
export function label(v: unknown, fallback = 'Unnamed device') {
  const text = String(v ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 80);
}

export async function hashFile(file: string) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

export async function readBody(req: IncomingMessage, max: number) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > max) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function jsonBody(req: IncomingMessage) {
  try {
    return JSON.parse((await readBody(req, JSON_LIMIT)).toString());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(data));
}

/* ------------------------------------------------------------------ aem-peer/1 auth */
export const PEER_HEADER = 'x-aem-peer-auth';
export const PEER_INVITE_HEADER = 'x-aem-peer-invite';
/** Clock skew a paired PC may drift by before requests are refused. */
export const PEER_SKEW_MS = 120_000;

export interface PeerAuth {mac: string; from: string; ts: number; nonce: string}

const canonical = (method: string, route: string, bodyHash: string, from: string, ts: number, nonce: string) =>
  `v1\n${method.toUpperCase()}\n${route}\n${bodyHash}\n${from}\n${ts}\n${nonce}`;

export function peerMac(hexKey: string, p: {method: string; route: string; body: Buffer; from: string; ts: number; nonce: string}) {
  return crypto.createHmac('sha256', Buffer.from(hexKey, 'hex'))
    .update(canonical(p.method, p.route, sha(p.body), p.from, p.ts, p.nonce)).digest('hex');
}

export function signPeerRequest(hexKey: string, p: {method: string; route: string; body: Buffer; from: string; ts: number; nonce: string}) {
  return `mac=${peerMac(hexKey, p)}; from=${p.from}; ts=${p.ts}; nonce=${p.nonce}`;
}

export function parsePeerAuth(header: string | string[] | undefined): PeerAuth | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const fields = new Map<string, string>();
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) fields.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  const mac = fields.get('mac') || '', from = fields.get('from') || '', nonce = fields.get('nonce') || '';
  const ts = Number(fields.get('ts'));
  if (!/^[a-f0-9]{64}$/.test(mac) || !/^[a-f0-9]{32}$/.test(from) || !/^[a-f0-9]{32}$/.test(nonce) || !Number.isSafeInteger(ts)) return null;
  return {mac, from, ts, nonce};
}

/** One canonical definition for both sides: parse, check the clock window, then re-compute the MAC. */
export function verifyPeerAuth(header: string | string[] | undefined, hexKey: string, p: {method: string; route: string; body: Buffer}) {
  const a = parsePeerAuth(header);
  if (!a) throw new HttpError(401, 'Missing or malformed pairing signature');
  if (Math.abs(Date.now() - a.ts) > PEER_SKEW_MS) throw new HttpError(403, 'Pairing signature is outside the clock window; sync both PC clocks');
  if (!equal(a.mac, peerMac(hexKey, {method: p.method, route: p.route, body: p.body, from: a.from, ts: a.ts, nonce: a.nonce}))) throw new HttpError(403, 'Pairing signature mismatch');
  return a;
}

/** 6-digit short auth code both PCs display during pairing. Both sides derive it from the one-use
 * invitation plus both certificate fingerprints, so it is spoken/compared, not trusted blindly. */
export function shortAuthCode(inviteToken: string, fpA: string, fpB: string) {
  const [lo, hi] = [normFp(fpA), normFp(fpB)].sort();
  const h = crypto.createHash('sha256').update(`aem-peer/1|sas|${inviteToken}|${lo}|${hi}`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** HKDF over the one-use invitation (the only shared secret), bound to both certificate
 * fingerprints and both nonces, so a re-used invitation cannot reuse a previous session key. */
export function derivePairSecret(inviteToken: string, fpA: string, fpB: string, nonceA: string, nonceB: string) {
  const [lo, hi] = [normFp(fpA), normFp(fpB)].sort();
  const [nlo, nhi] = [nonceA, nonceB].sort();
  const key = crypto.hkdfSync('sha256', Buffer.from(inviteToken), Buffer.from(`${lo}|${hi}|${nlo}|${nhi}`), 'aem-peer/1 v1', 32);
  return Buffer.from(key).toString('hex');
}
