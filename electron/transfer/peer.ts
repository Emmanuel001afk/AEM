/** AEM desktop ↔ desktop transfer — protocol `aem-peer/1`.
 *
 * Two AEM PCs on the same network exchange files directly: a persistent identity certificate whose
 * fingerprint both sides pin, a one-use invitation, an explicit consent dialog on *both* PCs, a 6-digit
 * short auth code to compare out of band, HMAC-signed requests (fresh nonce + clock window) so no
 * browser or LAN attacker can forge a transfer, per-chunk and whole-file SHA-256 verification, exact
 * resume offsets, quotas, and a local history. Nothing is uploaded, no catalog row is written, and a
 * received file is never executed or installed by this service.
 *
 * It is deliberately separate from `aem-lan/1` (the browser companion in ./service.ts) and from Android
 * Wi-Fi Direct protocol 6: it never accepts their credentials and never serves the browser assets.
 */
import https from 'https';
import type {ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse} from 'http';
import type {AddressInfo} from 'net';
import type {TLSSocket} from 'tls';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {generate} from 'selfsigned';
import {Bonjour} from 'bonjour-service';
import {
  PEER_CHUNK, PEER_MAX_FILE, PEER_MAX_TOTAL, FREE_RESERVE, PEER_HEADER, PEER_INVITE_HEADER, JSON_LIMIT,
  HttpError, json, jsonBody, readBody, sha, equal, randomId, normFp, label, hashFile, validateManifest,
  signPeerRequest, parsePeerAuth, verifyPeerAuth, shortAuthCode, derivePairSecret, limitLabel,
} from './protocol';

const INVITE_TTL_MS = 5 * 60_000;
const MAX_PEERS = 8;
const MAX_QUEUED = 64;
const MAX_BATCH = 16;
const NONCE_WINDOW = 4096;
const HISTORY_LIMIT = 200;
const DISCOVERY_TTL_MS = 45_000;
const RETRY_DELAYS = [400, 1200, 2500, 5000];
const PROGRESS_INTERVAL_MS = 200;
export const PEER_PROTOCOL = 'aem-peer/1';

export type PeerTransferState = 'queued' | 'pending' | 'complete' | 'declined' | 'cancelled' | 'failed';

export interface PeerConsentRequest {
  kind: 'pair-in' | 'pair-out' | 'receive';
  peer: string;
  address: string;
  fingerprint?: string;
  sas?: string;
  name?: string;
  size?: number;
  sha256?: string;
}

export interface PeerEvent {
  type: 'started' | 'paired' | 'unpaired' | 'invite' | 'progress' | 'completed' | 'failed' | 'declined' | 'cancelled';
  at: number;
  peer?: string;
  transferId?: string;
  name?: string;
  offset?: number;
  size?: number;
  message?: string;
}

export interface PublicPeer {id: string;name: string;address: string;port: number;fingerprint: string;sas: string;addedAt: number;lastSeenAt: number}
export interface DiscoveredPeer {id: string;name: string;address: string;port: number;fingerprint: string;seenAt: number;paired: boolean}
export interface PublicTransfer {
  id: string; name: string; size: number; sha256: string; offset: number;
  state: PeerTransferState; direction: 'send' | 'receive'; peerName: string; updatedAt: number; error?: string;
}
export interface PeerHistoryEntry {
  at: number; direction: 'send' | 'receive'; peer: string; name: string;
  size: number; sha256: string; state: 'complete' | 'declined' | 'cancelled' | 'failed'; note?: string;
}

export interface PeerStatus {
  running: boolean;
  protocol: string;
  id: string;
  name: string;
  fingerprint: string;
  port: number;
  urls: string[];
  invitation: string | null;
  inviteUntil: number;
  peers: PublicPeer[];
  discovered: DiscoveredPeer[];
  transfers: PublicTransfer[];
  history: PeerHistoryEntry[];
  maxFileBytes: number;
  chunkBytes: number;
  receiveDir: string;
}

export interface PeerOptions {
  root: string;
  stateDir: string;
  consent: (request: PeerConsentRequest) => Promise<boolean>;
  onEvent?: (event: PeerEvent) => void;
  advertise?: boolean;
  bindHost?: string;
  port?: number;
}

interface Identity {id: string;name: string;key: string;cert: string;fingerprint: string;createdAt: number}
interface PeerRecord extends PublicPeer {cert: string;secret: string;seen: Set<string>;source: 'invite' | 'accepted'}
interface TransferRecord {
  id: string; peerId: string; peerName: string; name: string; size: number; sha256: string; offset: number;
  state: PeerTransferState; direction: 'send' | 'receive'; file: string; source?: string; error?: string;
  updatedAt: number; busy: boolean; abort: boolean; lastProgress: number;
}

interface HttpResult {status: number; headers: IncomingHttpHeaders; body: Buffer}
interface Target {address: string; port: number; cert?: string; pin?: string}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const fpOf = (der: Buffer) => sha(der);

export class PeerTransferService {
  private server: https.Server | null = null;
  private starting: Promise<PeerStatus> | null = null;
  private identity: Identity | null = null;
  private peers = new Map<string, PeerRecord>();
  private transfers = new Map<string, TransferRecord>();
  private discovered = new Map<string, DiscoveredPeer>();
  private history: PeerHistoryEntry[] = [];
  private chain = new Map<string, Promise<void>>();
  private attempts = new Map<string, {count: number; until: number}>();
  private pendingConsent = new Set<string>();
  private cancelled = new Map<string, number>();
  private advertisement: Bonjour | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private invitation: string | null = null;
  private inviteToken = '';
  private inviteUntil = 0;
  private inviteBusy = false;
  private port = 0;
  private addresses: string[] = [];
  private generation = 0;

  constructor(private options: PeerOptions) {
    this.loadHistory();
  }

  get certificate() {return this.identity?.cert ?? '';}

  /* ------------------------------------------------------------------ identity, peers, history */
  private get identityFile() {return path.join(this.options.stateDir, 'peer-identity.json');}
  private get peerFile() {return path.join(this.options.stateDir, 'peers.json');}
  private get historyFile() {return path.join(this.options.stateDir, 'history.json');}

  private candidateAddresses() {
    const bind = this.options.bindHost;
    if (bind && bind !== '0.0.0.0' && bind !== '::') return [bind];
    return [...new Set(Object.values(os.networkInterfaces()).flat()
      .filter(a => a?.family === 'IPv4' && !a.internal)
      .map(a => a!.address))];
  }

  private async loadIdentity(): Promise<Identity> {
    if (this.identity) return this.identity;
    await fs.promises.mkdir(this.options.stateDir, {recursive: true, mode: 0o700}).catch(() => {});
    try {
      const saved = JSON.parse(fs.readFileSync(this.identityFile, 'utf8'));
      const cert = new crypto.X509Certificate(saved.cert);
      const usable = saved?.v === 1 && typeof saved.id === 'string' && /^[a-f0-9]{32}$/.test(saved.id) &&
        typeof saved.key === 'string' && saved.key.includes('PRIVATE KEY') && typeof saved.cert === 'string' &&
        (!cert.validTo || new Date(cert.validTo).getTime() > Date.now());
      if (usable) {
        this.identity = {
          id: saved.id, name: label(saved.name, os.hostname() || 'AEM PC'), key: saved.key, cert: saved.cert,
          fingerprint: normFp(cert.fingerprint256), createdAt: Number(saved.createdAt) || Date.now(),
        };
        this.loadPeers();
        return this.identity;
      }
    } catch { /* first run, or the identity file is unreadable — regenerate below */ }
    const hosts = this.candidateAddresses();
    const generated = await new Promise<{private: string;cert: string}>((resolve, reject) =>
      generate([{name: 'commonName', value: 'AEM Desktop Peer'}], {
        keySize: 2048, days: 3650, algorithm: 'sha256',
        extensions: [
          {name: 'basicConstraints', cA: false},
          {name: 'keyUsage', digitalSignature: true, keyEncipherment: true},
          {name: 'extKeyUsage', serverAuth: true, clientAuth: true},
          {name: 'subjectAltName', altNames: (hosts.length ? hosts : ['127.0.0.1']).map(ip => ({type: 7 as const, ip}))},
        ],
      }, (e, r) => e ? reject(e) : resolve(r)));
    const identity: Identity = {
      id: randomId(),
      name: label(os.hostname() || 'AEM PC'),
      key: generated.private,
      cert: generated.cert,
      fingerprint: normFp(new crypto.X509Certificate(generated.cert).fingerprint256),
      createdAt: Date.now(),
    };
    await this.writePrivate(this.identityFile, JSON.stringify({v: 1, id: identity.id, name: identity.name, key: identity.key, cert: identity.cert, createdAt: identity.createdAt}, null, 2));
    this.identity = identity;
    this.loadPeers();
    return identity;
  }

  private async writePrivate(file: string, text: string) {
    const tmp = `${file}.${randomId().slice(0, 8)}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
      await fs.promises.writeFile(tmp, text, {mode: 0o600});
      await fs.promises.rename(tmp, file);
    } catch (e) {
      await fs.promises.rm(tmp, {force: true}).catch(() => {});
      throw e;
    }
  }

  private loadPeers() {
    if (!this.peers.size) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.peerFile, 'utf8'));
        if (Array.isArray(saved)) {
          for (const p of saved) {
            if (!p || typeof p.cert !== 'string' || typeof p.secret !== 'string' || !/^[a-f0-9]{32}$/.test(String(p.id))) continue;
            let cert: crypto.X509Certificate;
            try {cert = new crypto.X509Certificate(p.cert);} catch {continue;}
            const fingerprint = normFp(cert.fingerprint256);
            if (!fingerprint || !equal(fingerprint, normFp(p.fingerprint))) continue;
            if (cert.validTo && new Date(cert.validTo).getTime() < Date.now()) continue;
            this.peers.set(String(p.id), {
              id: String(p.id), name: label(p.name, 'AEM PC'), address: String(p.address || ''), port: Number(p.port) || 0,
              cert: p.cert, fingerprint, secret: String(p.secret), sas: String(p.sas || ''),
              addedAt: Number(p.addedAt) || Date.now(), lastSeenAt: Number(p.lastSeenAt) || 0, seen: new Set(), source: 'accepted',
            });
          }
        }
      } catch { /* no paired PCs yet */ }
    }
    for (const [, d] of this.discovered) if (this.peers.has(d.id)) d.paired = true;
  }

  private persistPeers() {
    const rows = [...this.peers.values()].map(({seen: _seen, source: _source, ...p}) => p);
    void this.writePrivate(this.peerFile, JSON.stringify(rows, null, 2)).catch(() => {});
  }

  private loadHistory() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      if (Array.isArray(saved)) this.history = saved.filter(h => h && typeof h.name === 'string' && typeof h.state === 'string').slice(0, HISTORY_LIMIT);
    } catch { /* empty history */ }
  }

  private record(entry: PeerHistoryEntry) {
    this.history = [entry, ...this.history].slice(0, HISTORY_LIMIT);
    void this.writePrivate(this.historyFile, JSON.stringify(this.history, null, 2)).catch(() => {});
  }

  private async announce() {
    const generation = this.generation;
    for (const peer of this.peers.values()) {
      if (generation !== this.generation || !this.server) return;
      const route = '/peer/state';
      await this.request({address: peer.address, port: peer.port, cert: peer.cert}, 'GET', route, Buffer.alloc(0), {...this.authHeaders(peer, 'GET', route, Buffer.alloc(0)), 'X-AEM-Port': String(this.port)}).catch(() => null);
    }
  }

  private emit(event: Omit<PeerEvent, 'at'>) {
    try {this.options.onEvent?.({...event, at: Date.now()});} catch { /* the window may already be gone */ }
  }

  /* ------------------------------------------------------------------ lifecycle */
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {return await this.starting;} finally {this.starting = null;}
  }

  private async startInternal(): Promise<PeerStatus> {
    if (this.server) return this.status();
    this.generation++;
    const identity = await this.loadIdentity();
    await fs.promises.mkdir(path.join(this.options.root, '.pending'), {recursive: true, mode: 0o700}).catch(() => {});
    // A stopped or restarted session cannot resume: remove only AEM's own UUID-named partials.
    for (const name of await fs.promises.readdir(path.join(this.options.root, '.pending')).catch(() => [])) {
      if (/^[a-f0-9]{32}\.part$/.test(name)) await fs.promises.rm(path.join(this.options.root, '.pending', name), {force: true}).catch(() => {});
    }
    this.transfers.clear();
    this.addresses = this.candidateAddresses();
    const server = https.createServer({
      key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2',
      // Identity is enforced per request against the pinned peer certificate, so a client certificate
      // is requested but not chain-verified by OpenSSL (our peers are self-signed by design).
      requestCert: true, rejectUnauthorized: false,
    }, (req, res) => {
      void this.route(req, res).catch(e => {
        const status = e instanceof HttpError ? e.status : 500;
        if (!res.headersSent) {
          // An error can be raised before the request body was drained (an oversized chunk). Close the
          // connection with the reply so a keep-alive socket is never reused mid-message by either side.
          res.setHeader('Connection', 'close');
          json(res, {error: e instanceof HttpError ? e.message : 'Transfer operation failed'}, status);
        }
        else res.destroy();
      });
    });
    // A consent prompt can legitimately sit unanswered for minutes while the user reads it; the request
    // must outlive the dialog, and the client's idle timeout matches it.
    server.requestTimeout = 180_000;
    server.headersTimeout = 20_000;
    server.maxHeadersCount = 40;
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.bindHost ?? '0.0.0.0', () => {server.removeListener('error', reject); resolve();});
    });
    server.on('error', () => {void this.stop();});
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    if (this.options.advertise !== false) this.advertise();
    // Restart resilience: tell already-paired PCs where this PC listens now, so a new ephemeral port
    // does not strand a pairing. Presence only — it authorizes nothing by itself.
    void this.announce();
    return this.status();
  }

  private advertise() {
    try {
      const identity = this.identity;
      if (!identity) return;
      this.advertisement = new Bonjour(undefined, () => {});
      this.advertisement.publish({
        name: `AEM Peer ${identity.id.slice(0, 6)}`, type: 'aem-peer', port: this.port,
        txt: {protocol: PEER_PROTOCOL, id: identity.id, name: identity.name, fp: identity.fingerprint},
      });
      // Advertisement is discovery only — never authorization. A discovered PC still needs an invitation.
      this.browser = this.advertisement.find({type: 'aem-peer', protocol: 'tcp'}, (s: any) => {
        const id = String(s?.txt?.id ?? '');
        if (!/^[a-f0-9]{32}$/.test(id) || id === identity.id) return;
        const address = Array.isArray(s?.addresses) ? s.addresses.find((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) : undefined;
        if (!address || !Number.isSafeInteger(s?.port) || !s.port) return;
        this.discovered.set(id, {id, name: label(s?.txt?.name, 'AEM PC'), address, port: Number(s.port), fingerprint: normFp(s?.txt?.fp), seenAt: Date.now(), paired: this.peers.has(id)});
      });
      this.browser.on('down', (s: any) => {const id = String(s?.txt?.id ?? ''); this.discovered.delete(id);});
    } catch {
      this.advertisement?.destroy();
      this.advertisement = null;
      this.browser = null;
    }
  }

  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    this.generation++;
    for (const t of this.transfers.values()) t.abort = true;
    this.invitation = null; this.inviteToken = ''; this.inviteUntil = 0;
    this.discovered.clear();
    for (const p of this.peers.values()) p.seen.clear();
    try {this.browser?.stop();} catch { /* discovery already closed */ }
    this.browser = null;
    try {this.advertisement?.unpublishAll(); this.advertisement?.destroy();} catch { /* nothing published */ }
    this.advertisement = null;
    const server = this.server; this.server = null;
    if (server) {server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));}
    for (const t of this.transfers.values()) {
      if (t.direction === 'receive' && t.state !== 'complete') await fs.promises.rm(t.file, {force: true}).catch(() => {});
      if (t.state === 'queued' || t.state === 'pending') {
        t.state = 'failed'; t.error = 'PC sharing stopped — send again to restart this transfer'; t.updatedAt = Date.now();
        this.record({at: Date.now(), direction: t.direction, peer: t.peerName, name: t.name, size: t.size, sha256: t.sha256, state: 'failed', note: 'sharing stopped'});
      }
    }
    this.transfers.clear();
    this.chain.clear();
  }

  /* ------------------------------------------------------------------ status + settings */
  private publicTransfer(t: TransferRecord): PublicTransfer {
    return {id: t.id, name: t.name, size: t.size, sha256: t.sha256, offset: t.offset, state: t.state, direction: t.direction, peerName: t.peerName, updatedAt: t.updatedAt, ...(t.error ? {error: t.error} : {})};
  }

  private peersNow(): PublicPeer[] {
    return [...this.peers.values()].map(({cert: _cert, secret: _secret, seen: _seen, source: _source, ...p}) => p).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  private discoveredNow(): DiscoveredPeer[] {
    const now = Date.now();
    for (const [id, d] of this.discovered) {
      if (now - d.seenAt > DISCOVERY_TTL_MS) this.discovered.delete(id);
      else d.paired = this.peers.has(id);
    }
    return [...this.discovered.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  status(): PeerStatus {
    const identity = this.identity;
    const now = Date.now();
    return {
      running: !!this.server, protocol: PEER_PROTOCOL,
      id: identity?.id ?? '', name: identity?.name ?? '', fingerprint: identity?.fingerprint ?? '', port: this.port,
      urls: this.addresses.map(a => `https://${a}:${this.port}`),
      invitation: this.invitation && this.inviteUntil > now ? this.invitation : null,
      inviteUntil: this.inviteUntil,
      peers: this.peersNow(),
      discovered: this.discoveredNow(),
      transfers: [...this.transfers.values()].map(t => this.publicTransfer(t)).sort((a, b) => b.updatedAt - a.updatedAt),
      history: [...this.history],
      maxFileBytes: PEER_MAX_FILE, chunkBytes: PEER_CHUNK,
      receiveDir: this.options.root,
    };
  }

  async setName(name: string) {
    const identity = await this.loadIdentity();
    identity.name = label(name, identity.name);
    const snapshot = identity;
    await this.writePrivate(this.identityFile, JSON.stringify({v: 1, id: snapshot.id, name: snapshot.name, key: snapshot.key, cert: snapshot.cert, createdAt: snapshot.createdAt}, null, 2));
    return this.status();
  }

  clearHistory() {
    this.history = [];
    void this.writePrivate(this.historyFile, '[]').catch(() => {});
    return this.status();
  }

  /* ------------------------------------------------------------------ invitations + pairing */
  /** One active, one-use invitation. The code is the pairing credential: share it over a channel you
   * already trust, then compare the 6-digit code that appears on both PCs before approving. */
  async newInvite() {
    const identity = await this.loadIdentity();
    if (!this.server) throw new Error('Start PC-to-PC sharing first');
    const host = this.addresses[0];
    if (!host) throw new Error('No LAN IPv4 address found — connect this PC to a private network first');
    const token = crypto.randomBytes(32).toString('base64url');
    const payload = {v: 1, i: identity.id, n: identity.name, h: host, p: this.port, f: identity.fingerprint, t: token};
    this.invitation = `AEM1-${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    this.inviteToken = token;
    this.inviteUntil = Date.now() + INVITE_TTL_MS;
    this.emit({type: 'invite', message: 'New one-use invitation created'});
    return this.status();
  }

  parseInvite(code: string) {
    const raw = String(code ?? '').trim();
    const payloadText = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw.replace(/^aem1[-:/\s]*/i, '');
    let payload: any = null;
    try {payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString());} catch {throw new Error('That is not a valid AEM PC invitation code');}
    if (!payload || payload.v !== 1 || typeof payload.i !== 'string' || !/^[a-f0-9]{32}$/.test(payload.i) ||
        typeof payload.h !== 'string' || !payload.h || !Number.isSafeInteger(payload.p) || payload.p < 1 || payload.p > 65535 ||
        typeof payload.f !== 'string' || !/^[a-f0-9]{64}$/.test(normFp(payload.f)) ||
        typeof payload.t !== 'string' || payload.t.length < 32 || payload.t.length > 256) {
      throw new Error('Unsupported or incomplete invitation code');
    }
    return {id: payload.i as string, name: label(payload.n, 'AEM PC'), host: payload.h, port: payload.p as number, fingerprint: normFp(payload.f), token: payload.t};
  }

  /** Join a PC that published an invitation. Consent is asked here *and* on the other PC. */
  async pairWith(code: string) {
    const identity = await this.loadIdentity();
    if (!this.server) throw new Error('Start PC-to-PC sharing first');
    const invite = this.parseInvite(code);
    if (invite.id === identity.id) throw new Error('That is this PC’s own invitation code');
    if (this.peers.has(invite.id)) throw new Error('Already paired with that PC — unpair it first to re-pair');
    if (this.peers.size >= MAX_PEERS) throw new Error(`Peer limit reached (${MAX_PEERS})`);
    if (!await this.options.consent({kind: 'pair-out', peer: invite.name, address: `${invite.host}:${invite.port}`, fingerprint: invite.fingerprint, sas: shortAuthCode(invite.token, identity.fingerprint, invite.fingerprint)})) {
      throw new Error('Pairing cancelled on this PC');
    }
    const nonce = randomId();
    const route = '/peer/pair';
    const payload = Buffer.from(JSON.stringify({id: identity.id, name: identity.name, cert: identity.cert, nonce, host: this.addresses[0] ?? '', port: this.port}));
    const res = await this.request({address: invite.host, port: invite.port, pin: invite.fingerprint}, 'POST', route, payload, {
      [PEER_INVITE_HEADER]: invite.token, 'X-AEM-Port': String(this.port),
    });
    if (res.status !== 200) throw new Error(this.remoteError(res));
    let ack: any = null;
    try {ack = JSON.parse(res.body.toString());} catch {throw new Error('Peer returned an unreadable pairing reply');}
    let peerCert: crypto.X509Certificate;
    try {peerCert = new crypto.X509Certificate(String(ack?.cert ?? ''));} catch {throw new Error('Peer returned an unreadable certificate');}
    const peerFp = normFp(fpOf(Buffer.from(peerCert.raw)));
    // The certificate in the reply must be exactly the one the invitation pinned.
    if (!equal(peerFp, invite.fingerprint)) throw new Error('Peer certificate does not match the invitation fingerprint');
    const secretKey = derivePairSecret(invite.token, identity.fingerprint, peerFp, nonce, String(ack?.nonce ?? ''));
    if (!/^[a-f0-9]{64}$/.test(secretKey)) throw new Error('Pairing key exchange failed');
    this.peers.set(invite.id, {
      id: invite.id, name: label(ack?.name, invite.name), address: invite.host, port: Number(ack?.port) || invite.port,
      cert: peerCert.toString() ? String(ack.cert) : '', fingerprint: peerFp, secret: secretKey,
      sas: shortAuthCode(invite.token, identity.fingerprint, peerFp), addedAt: Date.now(), lastSeenAt: Date.now(),
      seen: new Set(), source: 'invite',
    });
    this.discovered.set(invite.id, {id: invite.id, name: label(ack?.name, invite.name), address: invite.host, port: Number(ack?.port) || invite.port, fingerprint: peerFp, seenAt: Date.now(), paired: true});
    this.persistPeers();
    this.emit({type: 'paired', peer: invite.name, message: 'Paired with an AEM PC'});
    return this.status();
  }

  unpair(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return this.status();
    for (const [id, t] of this.transfers) {
      if (t.peerId !== peerId) continue;
      t.abort = true;
      if (t.state !== 'complete') this.transfers.delete(id);
    }
    this.peers.delete(peerId);
    this.persistPeers();
    this.emit({type: 'unpaired', peer: peer.name, message: 'Pairing revoked; the shared key is deleted on this PC'});
    return this.status();
  }

  /* ------------------------------------------------------------------ sending */
  async send(peerId: string, files: string[]) {
    const identity = await this.loadIdentity();
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Pair with that PC first');
    if (!this.server) throw new Error('Start PC-to-PC sharing first');
    if (!Array.isArray(files) || !files.length) throw new Error('Select at least one file');
    if (files.length > MAX_BATCH) throw new Error(`Send at most ${MAX_BATCH} files at a time`);
    if (this.transfers.size + files.length > MAX_QUEUED) throw new Error('Transfer queue is full');
    for (const file of files) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat?.isFile()) throw new Error(`${path.basename(file)} is not a readable regular file`);
      if (!stat.size) throw new Error(`${path.basename(file)} is empty`);
      if (stat.size > PEER_MAX_FILE) throw new Error(`${path.basename(file)} exceeds the ${limitLabel(PEER_MAX_FILE)} per-file limit`);
      const id = randomId();
      const record: TransferRecord = {
        id, peerId, peerName: peer.name, name: path.basename(file), size: Number(stat.size), sha256: '', offset: 0,
        state: 'queued', direction: 'send', file: path.join(this.options.root, '.pending', `${id}.part`),
        source: file, updatedAt: Date.now(), busy: false, abort: false, lastProgress: 0,
      };
      this.transfers.set(id, record);
      this.emit({type: 'started', peer: peer.name, transferId: id, name: record.name, size: record.size, offset: 0, message: 'Hashing the source file…'});
      this.schedule(peer.id, () => this.deliver(id, peer, identity));
    }
    return this.status();
  }

  /** Resume a failed/interrupted outgoing transfer from the receiver's committed offset. */
  async resume(transferId: string) {
    const identity = await this.loadIdentity();
    const t = this.transfers.get(transferId);
    if (!t) throw new Error('That transfer is no longer queued on this PC');
    if (t.direction !== 'send') throw new Error('The PC that sent this file resumes it');
    const peer = this.peers.get(t.peerId);
    if (!peer) throw new Error('Pair with that PC again before resuming');
    if (!this.server) throw new Error('Start PC-to-PC sharing first');
    t.state = 'queued'; t.error = undefined; t.abort = false; t.updatedAt = Date.now();
    this.schedule(peer.id, () => this.deliver(t.id, peer, identity));
    return this.status();
  }

  async cancel(transferId: string) {
    const t = this.transfers.get(transferId);
    if (!t) return this.status();
    const peer = this.peers.get(t.peerId);
    t.abort = true;
    if (t.state !== 'complete') {
      this.rememberCancelled(t.id);
      if (t.direction === 'receive') {
        await fs.promises.rm(t.file, {force: true}).catch(() => {});
        this.record({at: Date.now(), direction: 'receive', peer: t.peerName, name: t.name, size: t.size, sha256: t.sha256, state: 'cancelled'});
      }
    }
    if (t.direction === 'send' && peer && this.server && t.state !== 'complete') {
      const route = `/peer/transfers/${t.id}/cancel`;
      await this.request({address: peer.address, port: peer.port, cert: peer.cert}, 'POST', route, Buffer.alloc(0), this.authHeaders(peer, 'POST', route, Buffer.alloc(0))).catch(() => null);
    }
    this.transfers.delete(transferId);
    this.emit({type: 'cancelled', peer: t.peerName, transferId, name: t.name, message: 'Cancelled and dropped from the queue'});
    return this.status();
  }

  /** Drop a row from the queue. A finished receive keeps its saved file; anything unfinished is
   * cancelled on both PCs so no orphan partial is left occupying quota. */
  async remove(transferId: string) {
    const t = this.transfers.get(transferId);
    if (!t) return this.status();
    if (t.state !== 'complete') return this.cancel(transferId);
    this.transfers.delete(transferId);
    return this.status();
  }

  private schedule(peerId: string, task: () => Promise<void>) {
    const previous = this.chain.get(peerId) ?? Promise.resolve();
    const next = previous.then(task).catch(() => {});
    this.chain.set(peerId, next);
    void next.finally(() => {if (this.chain.get(peerId) === next) this.chain.delete(peerId);});
  }

  private async deliver(transferId: string, peer: PeerRecord, identity: Identity) {
    const t = this.transfers.get(transferId);
    if (!t || t.busy) return;
    const generation = this.generation;
    t.busy = true;
    let handle: fs.promises.FileHandle | null = null;
    try {
      const source = t.source;
      if (!source) throw new Error('No source file is attached to this transfer');
      const stat0 = await fs.promises.stat(source).catch(() => null);
      if (!stat0?.isFile() || Number(stat0.size) !== t.size) throw new Error('Source file changed or disappeared; select it again');
      if (!t.sha256) t.sha256 = await hashFile(source);
      const route = '/peer/transfers';
      const manifest = Buffer.from(JSON.stringify({id: t.id, name: t.name, size: t.size, sha256: t.sha256, device: identity.name}));
      // Both the offer and the finalize are idempotent, so a transport hiccup is retried rather than
      // reported as a failure. An HTTP error status is never retried: it is an answer, not a lost packet.
      let res = await this.retry(`offer ${t.name}`, () => this.request({address: peer.address, port: peer.port, cert: peer.cert}, 'POST', route, manifest, {...this.authHeaders(peer, 'POST', route, manifest), 'X-AEM-Port': String(this.port)}), () => !t.abort && generation === this.generation && !!this.server);
      if (res.status === 403 && /declin/i.test(res.body.toString())) {
        t.state = 'declined'; t.error = 'Declined on the receiving PC'; t.updatedAt = Date.now();
        this.record({at: Date.now(), direction: 'send', peer: peer.name, name: t.name, size: t.size, sha256: t.sha256, state: 'declined'});
        this.emit({type: 'declined', peer: peer.name, transferId: t.id, name: t.name, message: t.error});
        return;
      }
      if (res.status === 410) {
        t.state = 'cancelled'; t.error = 'Cancelled on the receiving PC'; t.updatedAt = Date.now();
        this.record({at: Date.now(), direction: 'send', peer: peer.name, name: t.name, size: t.size, sha256: t.sha256, state: 'cancelled'});
        this.emit({type: 'cancelled', peer: peer.name, transferId: t.id, name: t.name, message: t.error});
        return;
      }
      if (res.status !== 200) throw new Error(this.remoteError(res));
      const ack = JSON.parse(res.body.toString());
      t.offset = Number(ack?.offset) || 0;
      if (ack?.state === 'complete') {
        await this.markComplete(t, peer);
        return;
      }
      t.state = 'pending'; t.updatedAt = Date.now();
      handle = await fs.promises.open(source, 'r');
      const buffer = Buffer.alloc(PEER_CHUNK);
      while (t.offset < t.size) {
        if (t.abort || generation !== this.generation || !this.server) throw new Error('Cancelled on this PC');
        const want = Math.min(PEER_CHUNK, t.size - t.offset);
        const read = await handle.read(buffer, 0, want, t.offset);
        const chunk = buffer.subarray(0, read.bytesRead);
        if (!chunk.length) throw new Error('Source file ended before the declared size');
        if ((await fs.promises.stat(source)).size !== t.size) throw new Error('Source file changed during transfer; start again');
        const chunkRoute = `/peer/transfers/${t.id}?offset=${t.offset}`;
        const headers = {...this.authHeaders(peer, 'PATCH', chunkRoute, chunk), 'X-Chunk-Sha256': sha(chunk), 'X-AEM-Port': String(this.port)};
        let attempt = 0;
        for (;;) {
          try {
            res = await this.request({address: peer.address, port: peer.port, cert: peer.cert}, 'PATCH', chunkRoute, chunk, headers);
          } catch (e) {
            if (t.abort || generation !== this.generation) throw new Error('Cancelled on this PC');
            if (attempt >= RETRY_DELAYS.length) throw new Error(`Peer unreachable: ${e instanceof Error ? e.message : String(e)}`);
            await sleep(RETRY_DELAYS[attempt++]);
            t.offset = (await this.stateOf(peer, t.id).catch(() => ({offset: t.offset, state: t.state}))).offset;
            continue;
          }
          if (res.status === 200) {
            t.offset = Number(JSON.parse(res.body.toString())?.offset) ?? t.offset;
            t.updatedAt = Date.now();
            this.progress(t, peer);
            break;
          }
          if (res.status === 409) {
            // The receiver is authoritative about committed bytes; re-sync and continue or stop.
            const state = await this.stateOf(peer, t.id).catch(() => null);
            if (!state) throw new Error('Receiver refused to re-sync the transfer offset');
            t.offset = state.offset;
            if (state.state === 'complete') {await this.markComplete(t, peer); return;}
            if (attempt >= RETRY_DELAYS.length) throw new Error('Receiver offset is not advancing');
            await sleep(RETRY_DELAYS[attempt++]);
            continue;
          }
          throw new Error(this.remoteError(res));
        }
      }
      const doneRoute = `/peer/transfers/${t.id}/complete`;
      res = await this.retry(`finalize ${t.name}`, () => this.request({address: peer.address, port: peer.port, cert: peer.cert}, 'POST', doneRoute, Buffer.alloc(0), {...this.authHeaders(peer, 'POST', doneRoute, Buffer.alloc(0)), 'X-AEM-Port': String(this.port)}), () => !t.abort && generation === this.generation && !!this.server);
      if (res.status !== 200) throw new Error(this.remoteError(res));
      await this.markComplete(t, peer);
    } catch (e) {
      const current = this.transfers.get(transferId);
      if (current && current.state !== 'complete' && current.state !== 'declined') {
        current.state = 'failed';
        current.error = e instanceof Error ? e.message : String(e);
        current.updatedAt = Date.now();
        this.record({at: Date.now(), direction: 'send', peer: peer.name, name: current.name, size: current.size, sha256: current.sha256, state: 'failed', note: current.error});
        this.emit({type: 'failed', peer: peer.name, transferId, name: current.name, message: current.error});
      }
    } finally {
      await handle?.close().catch(() => {});
      t.busy = false;
    }
  }

  /** Retry a transport-level failure with backoff. The caller must make the action idempotent. */
  private async retry<T>(labelText: string, fn: () => Promise<T>, keepGoing: () => boolean): Promise<T> {
    let last: unknown = null;
    for (let attempt = 0; ; attempt++) {
      try {return await fn();} catch (e) {
        last = e;
        if (attempt >= RETRY_DELAYS.length || !keepGoing()) break;
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
    throw new Error(`${labelText}: ${last instanceof Error ? last.message : String(last)}`);
  }

  private async markComplete(t: TransferRecord, peer: PeerRecord) {
    t.state = 'complete'; t.offset = t.size; t.updatedAt = Date.now();
    if (!this.history.some(h => h.state === 'complete' && h.direction === 'send' && h.name === t.name && h.sha256 === t.sha256)) {
      this.record({at: Date.now(), direction: 'send', peer: peer.name, name: t.name, size: t.size, sha256: t.sha256, state: 'complete'});
    }
    this.emit({type: 'completed', peer: peer.name, transferId: t.id, name: t.name, offset: t.size, size: t.size, message: 'SHA-256 verified and saved on the receiving PC'});
  }

  private progress(t: TransferRecord, peer: PeerRecord) {
    const now = Date.now();
    if (t.offset < t.size && now - t.lastProgress < PROGRESS_INTERVAL_MS) return;
    t.lastProgress = now;
    this.emit({type: 'progress', peer: peer.name, transferId: t.id, name: t.name, offset: t.offset, size: t.size});
  }

  private async stateOf(peer: PeerRecord, transferId: string) {
    const route = `/peer/transfers/${transferId}`;
    const res = await this.request({address: peer.address, port: peer.port, cert: peer.cert}, 'GET', route, Buffer.alloc(0), {...this.authHeaders(peer, 'GET', route, Buffer.alloc(0)), 'X-AEM-Port': String(this.port)});
    if (res.status !== 200) throw new Error(this.remoteError(res));
    const j = JSON.parse(res.body.toString());
    return {offset: Number(j?.offset) || 0, state: String(j?.state ?? 'pending') as PeerTransferState};
  }

  private remoteError(res: HttpResult) {
    let message = '';
    try {message = String(JSON.parse(res.body.toString())?.error ?? '');} catch {message = res.body.toString().slice(0, 200);}
    return message || `Peer responded with HTTP ${res.status}`;
  }

  /** Best-effort presence check for a discovered record; identity still requires an invitation. */
  async probe(target: {address: string; port: number}) {
    const res = await this.request({address: target.address, port: target.port}, 'GET', '/peer/hello', Buffer.alloc(0), {}).catch(() => null);
    if (!res || res.status !== 200) return null;
    try {
      const j = JSON.parse(res.body.toString());
      return {id: String(j?.id ?? ''), name: label(j?.name, 'AEM PC'), fingerprint: normFp(j?.fingerprint), protocol: String(j?.protocol ?? ''), port: Number(j?.port) || target.port};
    } catch {return null;}
  }

  /* ------------------------------------------------------------------ client transport */
  private authHeaders(peer: PeerRecord, method: string, route: string, payload: Buffer) {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {[PEER_HEADER]: signPeerRequest(peer.secret, {method, route, body: payload, from: this.identity!.id, ts, nonce})};
  }

  /** Pinned, mutually authenticated HTTPS. `cert` pins a paired peer's certificate as the only trust
   * anchor; `pin` (pairing only) checks the presented fingerprint before any byte is trusted. */
  private request(target: Target, method: string, route: string, payload: Buffer, headers: Record<string, string>) {
    if (!target.address || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) {
      return Promise.reject(new Error('Peer address is not reachable from this PC'));
    }
    const pin = target.pin ? normFp(target.pin) : '';
    return new Promise<HttpResult>((resolve, reject) => {
      let req: ClientRequest;
      try {
        req = https.request({
          host: target.address, port: target.port, path: route, method,
          key: this.identity?.key, cert: this.identity?.cert,
          ...(target.cert ? {ca: target.cert, rejectUnauthorized: true} : {rejectUnauthorized: false}),
          // Node rejects an explicitly undefined checkServerIdentity, so only pin when we have to.
          ...(pin ? {agent: false, checkServerIdentity: () => undefined} : {}),
          timeout: 180_000,
          headers: {...headers, 'Content-Length': String(payload.length)},
        }, res => {
          const chunks: Buffer[] = [];
          let n = 0;
          res.on('data', c => {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
            n += b.length;
            if (n > 1024 * 512) {res.destroy(new Error('Peer response too large')); return;}
            chunks.push(b);
          });
          res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}));
          res.on('error', reject);
        });
      } catch (e) {reject(e instanceof Error ? e : new Error(String(e))); return;}
      req.on('timeout', () => req.destroy(new Error('Peer timed out')));
      req.on('error', reject);
      if (pin) {
        req.on('socket', (socket: TLSSocket) => {
          socket.once('secureConnect', () => {
            const raw = socket.getPeerCertificate?.(true)?.raw;
            if (!raw || !equal(fpOf(Buffer.from(raw)), pin)) req.destroy(new Error('Peer TLS certificate does not match the pinned fingerprint'));
          });
        });
      }
      req.end(payload);
    });
  }

  /* ------------------------------------------------------------------ server routes */
  /** A declined or failed row is only kept long enough to answer a retried offer, never forever. */
  private pruneTerminal() {
    for (const [key, t] of this.transfers) if ((t.state === 'declined' || t.state === 'failed') && Date.now() - t.updatedAt > 15 * 60_000) this.transfers.delete(key);
  }

  private rememberCancelled(transferId: string) {
    this.cancelled.set(transferId, Date.now());
    if (this.cancelled.size > 256) {
      const oldest = this.cancelled.keys().next().value;
      if (oldest !== undefined) this.cancelled.delete(oldest);
    }
  }

  private nonceCheck(peer: PeerRecord, nonce: string) {
    if (peer.seen.has(nonce)) throw new HttpError(403, 'Replayed request — it was not applied twice');
    if (peer.seen.size >= NONCE_WINDOW) {
      const oldest = peer.seen.values().next().value;
      if (oldest !== undefined) peer.seen.delete(oldest);
    }
    peer.seen.add(nonce);
  }

  private peerFor(req: IncomingMessage, payload: Buffer) {
    const route = (req.url || '/').split('#')[0];
    const auth = parsePeerAuth(req.headers[PEER_HEADER]);
    if (!auth) throw new HttpError(401, 'Missing or malformed pairing signature');
    const peer = this.peers.get(auth.from);
    if (!peer) throw new HttpError(401, 'This PC is not paired with that device');
    const raw = (req.socket as TLSSocket)?.getPeerCertificate?.(true)?.raw;
    if (!raw) throw new HttpError(403, 'Peer did not present its pinned certificate');
    if (!equal(fpOf(Buffer.from(raw)), peer.fingerprint)) throw new HttpError(403, 'Peer certificate does not match the pinned identity');
    // Same canonical string the sender signs, verified against this peer's own key.
    verifyPeerAuth(req.headers[PEER_HEADER], peer.secret, {method: req.method || 'GET', route, body: payload});
    this.nonceCheck(peer, auth.nonce);
    peer.lastSeenAt = Date.now();
    if (req.socket.remoteAddress) peer.address = req.socket.remoteAddress.replace(/^::ffff:/, '');
    const declaredPort = Number(req.headers['x-aem-port']);
    if (Number.isSafeInteger(declaredPort) && declaredPort > 0 && declaredPort < 65536) peer.port = declaredPort;
    return {peer, route};
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-AEM-Protocol', PEER_PROTOCOL);
    const url = new URL(req.url || '/', 'https://peer.invalid');
    const address = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    if (req.method === 'GET' && url.pathname === '/peer/hello') {
      json(res, {protocol: PEER_PROTOCOL, id: this.identity?.id ?? '', name: this.identity?.name ?? '', fingerprint: this.identity?.fingerprint ?? '', port: this.port, maxFileBytes: PEER_MAX_FILE, chunkBytes: PEER_CHUNK, invitationActive: !!this.invitation && Date.now() < this.inviteUntil});
      return;
    }
    if (req.method === 'POST' && url.pathname === '/peer/pair') {
      let a = this.attempts.get(address);
      if (!a || a.until < Date.now()) {
        if (this.attempts.size >= 128) this.attempts.clear();
        a = {count: 0, until: Date.now() + 60_000};
        this.attempts.set(address, a);
      }
      if (++a.count > 6) throw new HttpError(429, 'Pairing rate limit — wait a minute');
      const header = req.headers[PEER_INVITE_HEADER];
      const token = String(Array.isArray(header) ? header[0] : header ?? '');
      if (this.inviteBusy || !this.inviteToken || Date.now() > this.inviteUntil || !equal(token, this.inviteToken)) throw new HttpError(403, 'Invalid or expired invitation');
      const b = await jsonBody(req);
      if (!b || typeof b.id !== 'string' || !/^[a-f0-9]{32}$/.test(b.id) || typeof b.cert !== 'string' ||
          typeof b.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(b.nonce)) throw new HttpError(400, 'Incomplete pairing request');
      if (b.id === this.identity?.id) throw new HttpError(400, 'A PC cannot pair with itself');
      if (this.peers.has(b.id)) throw new HttpError(409, 'That PC is already paired here');
      if (this.peers.size >= MAX_PEERS) throw new HttpError(429, `Peer limit (${MAX_PEERS}) reached`);
      let peerCert: crypto.X509Certificate;
      try {peerCert = new crypto.X509Certificate(b.cert);} catch {throw new HttpError(400, 'Unreadable peer certificate');}
      if (peerCert.validTo && new Date(peerCert.validTo).getTime() < Date.now()) throw new HttpError(403, 'Peer certificate has expired; refresh its identity');
      const peerFp = normFp(fpOf(Buffer.from(peerCert.raw)));
      const sas = shortAuthCode(this.inviteToken, this.identity!.fingerprint, peerFp);
      const generation = this.generation;
      this.inviteBusy = true;
      try {
        const approved = await this.options.consent({kind: 'pair-in', peer: label(b.name, 'AEM PC'), address, fingerprint: peerFp, sas});
        if (!approved) throw new HttpError(403, 'Pairing declined on this PC');
        if (generation !== this.generation || !this.inviteToken || Date.now() > this.inviteUntil) throw new HttpError(403, 'Invitation is no longer active');
        const nonce = randomId();
        const secretKey = derivePairSecret(this.inviteToken, this.identity!.fingerprint, peerFp, String(b.nonce), nonce);
        const declaredPort = Number(b.port);
        this.peers.set(b.id, {
          id: b.id, name: label(b.name, 'AEM PC'), address, port: Number.isSafeInteger(declaredPort) && declaredPort > 0 ? declaredPort : 0,
          cert: b.cert, fingerprint: peerFp, secret: secretKey, sas, addedAt: Date.now(), lastSeenAt: Date.now(),
          seen: new Set(), source: 'accepted',
        });
        this.invitation = null; this.inviteToken = ''; this.inviteUntil = 0;
        this.persistPeers();
        this.emit({type: 'paired', peer: label(b.name, 'AEM PC'), message: `Paired — both PCs must have shown code ${sas}`});
        json(res, {protocol: PEER_PROTOCOL, id: this.identity!.id, name: this.identity!.name, cert: this.identity!.cert, port: this.port, nonce, sas, maxFileBytes: PEER_MAX_FILE, chunkBytes: PEER_CHUNK});
      } finally {this.inviteBusy = false;}
      return;
    }
    const isChunk = req.method === 'PATCH';
    const payload = await readBody(req, isChunk ? PEER_CHUNK : JSON_LIMIT);
    const {peer} = this.peerFor(req, payload);
    const transferRoute = /^\/peer\/transfers\/([a-f0-9]{32})(\/complete|\/cancel)?$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/peer/state') {
      json(res, {peer: {id: peer.id, name: peer.name}, protocol: PEER_PROTOCOL, transfers: [...this.transfers.values()].filter(t => t.peerId === peer.id).map(t => this.publicTransfer(t))});
      return;
    }
    if (req.method === 'POST' && url.pathname === '/peer/transfers') {
      let declared: any = null;
      try {declared = JSON.parse(payload.toString());} catch {throw new HttpError(400, 'Invalid JSON');}
      const m = validateManifest(declared, PEER_MAX_FILE);
      if (!declared || typeof declared.id !== 'string' || !/^[a-f0-9]{32}$/.test(declared.id)) throw new HttpError(400, 'Missing transfer id');
      const id: string = declared.id;
      const existing = this.transfers.get(id);
      if (existing) {
        // Replay-safe: the same manifest returns the committed state, a different one is refused.
        if (existing.peerId !== peer.id) throw new HttpError(409, 'That transfer id belongs to another peer');
        if (existing.name !== m.name || existing.size !== m.size || existing.sha256 !== m.sha256) throw new HttpError(409, 'Same transfer id with a different manifest');
        if (existing.state === 'declined') throw new HttpError(403, 'Declined on this PC — select the file again to ask once more');
        json(res, this.publicTransfer(existing));
        return;
      }
      this.pruneTerminal();
      const dupe = [...this.transfers.values()].find(x => x.peerId === peer.id && x.direction === 'receive' && x.state === 'complete' && x.sha256 === m.sha256 && x.name === m.name);
      if (dupe) {json(res, this.publicTransfer(dupe)); return;}
      if (this.transfers.size >= MAX_QUEUED) throw new HttpError(429, 'Transfer queue is full');
      // One consent prompt at a time per peer: offers never stack dialogs, but a finished or declined
      // transfer never wedges the channel either.
      if (this.pendingConsent.has(peer.id)) throw new HttpError(409, 'Another offer is still waiting for approval on this PC');
      this.pendingConsent.add(peer.id);
      try {
        const approved = await this.options.consent({kind: 'receive', peer: peer.name, address, name: m.name, size: m.size, sha256: m.sha256});
        if (!approved) {
          this.transfers.set(id, {id, peerId: peer.id, peerName: peer.name, ...m, offset: 0, state: 'declined', direction: 'receive', file: '', busy: false, abort: false, lastProgress: 0, updatedAt: Date.now(), error: 'Declined on this PC'});
          this.record({at: Date.now(), direction: 'receive', peer: peer.name, name: m.name, size: m.size, sha256: m.sha256, state: 'declined'});
          this.emit({type: 'declined', peer: peer.name, transferId: id, name: m.name, message: 'Declined; the sending PC does not retry automatically'});
          throw new HttpError(403, 'Declined on the receiving PC');
        }
        const disk = await fs.promises.statfs(this.options.root);
        const used = [...this.transfers.values()].filter(x => x.direction === 'receive').reduce((s, x) => s + x.size, 0);
        if (used + m.size > PEER_MAX_TOTAL || disk.bavail * disk.bsize < m.size + FREE_RESERVE) throw new HttpError(507, `Insufficient transfer quota or free disk space (${limitLabel(PEER_MAX_TOTAL)} per session, ${limitLabel(FREE_RESERVE)} reserve)`);
        const file = path.join(this.options.root, '.pending', `${id}.part`);
        const record: TransferRecord = {id, peerId: peer.id, peerName: peer.name, ...m, offset: 0, state: 'pending', direction: 'receive', file, busy: false, abort: false, lastProgress: 0, updatedAt: Date.now()};
        this.transfers.set(id, record);
        try {
          await fs.promises.writeFile(file, '', {flag: 'wx', mode: 0o600});
          this.emit({type: 'started', peer: peer.name, transferId: id, name: m.name, size: m.size, offset: 0, message: 'Receiving'});
          json(res, this.publicTransfer(record));
        } catch (e) {this.transfers.delete(id); throw e;}
      } finally {this.pendingConsent.delete(peer.id);}
      return;
    }
    if (!transferRoute) throw new HttpError(404, 'Not found');
    const t = this.transfers.get(transferRoute[1]);
    if (!t || t.peerId !== peer.id) {
      if (this.cancelled.has(transferRoute[1])) throw new HttpError(410, 'Cancelled on the receiving PC');
      throw new HttpError(404, 'Not found');
    }
    if (req.method === 'GET') {json(res, this.publicTransfer(t)); return;}
    if (transferRoute[2] === '/cancel') {
      if (req.method !== 'POST') throw new HttpError(405, 'Unsupported operation');
      t.abort = true;
      if (t.state !== 'complete') {
        await fs.promises.rm(t.file, {force: true}).catch(() => {});
        this.rememberCancelled(t.id);
        this.record({at: Date.now(), direction: 'receive', peer: peer.name, name: t.name, size: t.size, sha256: t.sha256, state: 'cancelled'});
      }
      this.transfers.delete(t.id);
      json(res, {ok: true, removed: true});
      return;
    }
    if (req.method === 'POST' && transferRoute[2] === '/complete') {
      if (t.state === 'complete') {json(res, this.publicTransfer(t)); return;}
      if (t.busy) throw new HttpError(409, 'File is in use');
      if (t.offset !== t.size) throw new HttpError(409, 'File is incomplete');
      t.busy = true;
      try {
        if (await hashFile(t.file) !== t.sha256) {
          await fs.promises.truncate(t.file, 0);
          t.offset = 0; t.updatedAt = Date.now();
          this.record({at: Date.now(), direction: 'receive', peer: peer.name, name: t.name, size: t.size, sha256: t.sha256, state: 'failed', note: 'final checksum mismatch'});
          throw new HttpError(422, 'Final checksum mismatch; partial file reset');
        }
        const target = path.join(this.options.root, `${t.id}-${t.name}`);
        await fs.promises.rename(t.file, target);
        t.file = target; t.state = 'complete'; t.updatedAt = Date.now();
        this.record({at: Date.now(), direction: 'receive', peer: peer.name, name: t.name, size: t.size, sha256: t.sha256, state: 'complete'});
        this.emit({type: 'completed', peer: peer.name, transferId: t.id, name: t.name, offset: t.size, size: t.size, message: `Saved in ${this.options.root}`});
        json(res, this.publicTransfer(t));
        return;
      } finally {t.busy = false;}
    }
    if (req.method === 'PATCH') {
      if (t.state === 'complete') throw new HttpError(409, 'Already complete');
      if (t.busy) throw new HttpError(409, 'File is in use');
      if (!payload.length) throw new HttpError(400, 'Empty chunk');
      t.busy = true;
      try {
        const offset = Number(url.searchParams.get('offset'));
        t.offset = (await fs.promises.stat(t.file).catch(() => ({size: -1}))).size;
        if (!Number.isSafeInteger(offset) || offset !== t.offset || t.offset + payload.length > t.size) throw new HttpError(409, 'Offset mismatch; re-sync the transfer state');
        if (typeof req.headers['x-chunk-sha256'] !== 'string' || !equal(sha(payload), req.headers['x-chunk-sha256'])) throw new HttpError(422, 'Chunk checksum mismatch');
        const fd = await fs.promises.open(t.file, 'r+');
        try {
          let written = 0;
          while (written < payload.length) {
            const w = await fd.write(payload, written, payload.length - written, offset + written);
            if (!w.bytesWritten) throw new Error('Short write');
            written += w.bytesWritten;
          }
          await fd.sync();
        } finally {await fd.close();}
        t.offset += payload.length;
        t.state = 'pending';
        t.updatedAt = Date.now();
        this.progress(t, peer);
        json(res, this.publicTransfer(t));
        return;
      } finally {t.busy = false;}
    }
    throw new HttpError(405, 'Unsupported operation');
  }
}
