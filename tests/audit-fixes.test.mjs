import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
import yazl from 'yazl';
import selfsigned from 'selfsigned';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const electronTestRoot = fss.mkdtempSync(path.join(os.tmpdir(), 'aem-electron-stub-'));
const originalLoad = Module._load;
let sdkMod, mgrMod;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getPath: () => electronTestRoot,
        getVersion: () => '0.1.0',
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};
try {
  sdkMod = require('../dist-electron/emulator/sdk.js');
  mgrMod = require('../dist-electron/emulator/manager.js');
} finally {
  Module._load = originalLoad;
}
const {unzipSafe} = sdkMod;
const {EmulatorManager} = mgrMod;
const {PeerTransferService} = require('../dist-electron/transfer/peer.js');

async function loadTs(relPath, supabaseMockJson) {
  const full = path.resolve(relPath);
  let source = fss.readFileSync(full, 'utf8');
  if (relPath === 'src/services/catalog/supabase.ts') {
    const mockFn = supabaseMockJson !== undefined
      ? `const supabaseRequest = async () => ({ ok: true, status: 200, json: async () => (${JSON.stringify(supabaseMockJson)}) });`
      : 'const supabaseRequest = async () => { throw new Error("stub"); };';
    source = source
      .replace('import {selectLatestWindowsRelease} from "../../domain/version";', '')
      .replace('import type {StoreApp} from "../../domain/catalog";', '')
      .replace('import {supabaseRequest} from "../supabase/client";', mockFn)
      .replace('selectLatestWindowsRelease', '((x:any[])=>x[0])');
  }
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}

test('mapSupabaseRelease normalizes snake_case release history rows for androidArtifact', async () => {
  const {mapSupabaseRelease} = await loadTs('src/services/catalog/supabase.ts');
  const {androidArtifact} = await loadTs('src/domain/platform.ts');
  const raw = {
    id: 42,
    version_name: '2.1.0',
    version_code: 210,
    channel: 'stable',
    status: 'published',
    title: 'v2.1.0',
    notes: 'Fixes',
    published_at: '2026-10-01T00:00:00Z',
    artifacts: [{
      id: 99,
      platform: 'android',
      kind: 'apk',
      filename: 'app-release.apk',
      download_url: 'https://example.test/app-release.apk',
      size_bytes: 123456,
      sha256: 'a'.repeat(64),
      package_identity: 'com.example.app',
      signing_certificate_sha256: 'b'.repeat(64),
      version_code: 210,
      artifact_version_name: '2.1.0',
      signing_status: 'ready',
    }],
  };
  const mapped = mapSupabaseRelease({provider: 'github', project: 'org/app'}, raw);
  assert.equal(mapped.version.name, '2.1.0');
  assert.equal(mapped.version.code, 210);
  const picked = androidArtifact(mapped, 'com.example.app');
  assert.ok(picked, 'mapped history release must resolve through androidArtifact');
  assert.equal(picked.downloadUrl, 'https://example.test/app-release.apk');
  assert.equal(picked.signingStatus, 'ready');
  assert.equal(picked.versionCode, 210);
});

test('selectLatestRelease excludes pending and failed Android artifacts while allowing ready ones', async () => {
  const {createManager} = await loadTs('src/services/manager.ts');
  const mgr = createManager({loadCatalog: async () => []});
  const latest = mgr.selectLatestRelease([
    {
      id: '2',
      status: 'published',
      version: {name: '2.0.0', code: 20},
      artifacts: [{platform: 'android', kind: 'apk', signingStatus: 'pending'}],
    },
    {
      id: '3',
      status: 'published',
      version: {name: '3.0.0', code: 30},
      artifacts: [{platform: 'android', kind: 'apk', signingStatus: 'failed'}],
    },
    {
      id: '1',
      status: 'published',
      version: {name: '1.0.0', code: 10},
      artifacts: [{platform: 'android', kind: 'apk', signingStatus: 'ready'}],
    },
  ]);
  assert.equal(latest?.id, '1');
  const legacy = mgr.selectLatestRelease([
    {id: 'legacy', status: 'published', version: {name: '1.1.0', code: 11}, artifacts: [{platform: 'android', kind: 'apk'}]},
  ]);
  assert.equal(legacy?.id, 'legacy');
});

test('unzipSafe blocks path traversal, rejects symlinks, and restores Unix executable bits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aem-unzip-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const travZip = path.join(dir, 'traversal.zip');
  {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('pwn'), 'aa/escape.txt');
    const p = pipeline(zip.outputStream, fss.createWriteStream(travZip));
    zip.end();
    await p;
    const rawZip = await fs.readFile(travZip);
    const patched = Buffer.from(rawZip.toString('latin1').replaceAll('aa/escape.txt', '../escape.txt'), 'latin1');
    await fs.writeFile(travZip, patched);
  }
  await assert.rejects(() => unzipSafe(travZip, path.join(dir, 'out1')), /Unsafe SDK archive traversal|invalid relative path/);

  const symZip = path.join(dir, 'symlink.zip');
  {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('/etc/passwd'), 'link', {mode: 0o120777});
    const p = pipeline(zip.outputStream, fss.createWriteStream(symZip));
    zip.end();
    await p;
  }
  await assert.rejects(() => unzipSafe(symZip, path.join(dir, 'out2')), /Symlink not permitted/);

  const goodZip = path.join(dir, 'good.zip');
  {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('#!/bin/sh\necho ok\n'), 'bin/adb', {mode: 0o100755});
    const p = pipeline(zip.outputStream, fss.createWriteStream(goodZip));
    zip.end();
    await p;
  }
  const out3 = path.join(dir, 'out3');
  await unzipSafe(goodZip, out3);
  const extracted = path.join(out3, 'bin', 'adb');
  assert.equal(await fs.readFile(extracted, 'utf8'), '#!/bin/sh\necho ok\n');
  if (process.platform !== 'win32') {
    const mode = (await fs.stat(extracted)).mode & 0o777;
    assert.ok((mode & 0o111) !== 0, `expected executable bit set, got ${mode.toString(8)}`);
  }
});

test('EmulatorManager.shell rejects arbitrary commands before running ADB', async () => {
  const mgr = EmulatorManager.getInstance();
  for (const cmd of ['rm -rf /', 'sh -c id', 'getprop foo; id', 'input keyevent 82 && id', '']) {
    await assert.rejects(() => mgr.shell(cmd), /Unsupported emulator shell command/);
  }
  for (const cmd of ['getprop', 'getprop ro.build.version.sdk', 'input keyevent 82', 'pm list features']) {
    await assert.rejects(() => mgr.shell(cmd), (err) => !/Unsupported emulator shell command/.test(err.message));
  }
});

test('PeerTransferService verifies server certificate fingerprint on TLS connections', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aem-peer-pin-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const alice = new PeerTransferService({root: path.join(dir, 'alice'), stateDir: path.join(dir, 'alice-state'), advertise: false, bindHost: '127.0.0.1', consent: async () => true});
  await alice.start();
  t.after(async () => { try { await alice.stop(); } catch {} });

  // Spin up an imposter HTTPS server using a DIFFERENT self-signed certificate
  const imposterCert = await selfsigned.generate([{name: 'commonName', value: 'imposter'}], {days: 1, keySize: 2048, algorithm: 'sha256'});
  const imposterServer = https.createServer({key: imposterCert.private, cert: imposterCert.cert}, (_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => imposterServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => imposterServer.close(resolve)); });
  const imposterPort = imposterServer.address().port;

  // Manually register peer pointing at imposter's port but expecting a mismatched fingerprint (while giving imposter CA to pass standard TLS chain)
  alice.peers.set('imposter-id', {
    id: 'imposter-id',
    name: 'Imposter',
    address: '127.0.0.1',
    port: imposterPort,
    fingerprint: '00'.repeat(32),
    sas: '123456',
    cert: imposterCert.cert,
    secret: 'ab'.repeat(32),
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
    seen: new Map(),
  });
  await assert.rejects(
    () => alice.request({address: '127.0.0.1', port: imposterPort, cert: imposterCert.cert, certFingerprint: '00'.repeat(32)}, 'GET', '/peer/state', Buffer.alloc(0), {}),
    /fingerprint mismatch/i
  );
});

test('PeerTransferService prunes terminal rows instead of blocking future sends', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aem-peer-prune-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));

  const alice = new PeerTransferService({root: path.join(dir, 'alice'), stateDir: path.join(dir, 'alice-state'), advertise: false, bindHost: '127.0.0.1', consent: async () => true});
  const bob = new PeerTransferService({root: path.join(dir, 'bob'), stateDir: path.join(dir, 'bob-state'), advertise: false, bindHost: '127.0.0.1', consent: async () => true});
  await alice.start();
  await bob.start();
  t.after(async () => { try { await alice.stop(); } catch {} try { await bob.stop(); } catch {} });

  const {invitation} = await alice.newInvite();
  await bob.pairWith(invitation);

  // Fill bob.transfers with 256 completed/declined terminal rows to exercise pruneTerminal()
  for (let i = 0; i < 256; i++) {
    bob.transfers.set(`old-${i}`, {
      id: crypto.randomBytes(16).toString('hex'),
      name: `old-${i}.bin`,
      size: 1,
      sha256: 'a'.repeat(64),
      offset: 1,
      state: i % 2 === 0 ? 'complete' : 'declined',
      direction: 'send',
      peerId: alice.status().id,
      peerName: 'Alice',
      file: path.join(dir, `old-${i}.bin`),
      updatedAt: Date.now() - (300 - i) * 1000,
    });
  }

  const realFile = path.join(dir, 'fresh.txt');
  await fs.writeFile(realFile, 'hello after pruning');
  await bob.send(alice.status().id, [realFile]);

  const started = Date.now();
  let landed;
  while (Date.now() - started < 10000) {
    landed = alice.status().transfers.find((x) => x.name === 'fresh.txt' && x.state === 'complete');
    if (landed) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(landed, 'transfer must succeed after pruning terminal rows');
});

after(() => {
  fss.rmSync(electronTestRoot, {recursive: true, force: true});
});

test('Supabase Edge Functions preserve auth, OIDC, signing-failure tracking and constant-time checks', () => {
  const publishFn = fss.readFileSync(path.resolve('supabase/functions/aem-publish-github-artifact/index.ts'), 'utf8');
  const triggerFn = fss.readFileSync(path.resolve('supabase/functions/aem-trigger-android-signing/index.ts'), 'utf8');
  const signingFn = fss.readFileSync(path.resolve('supabase/functions/aem-android-signing/index.ts'), 'utf8');
  const syncFn = fss.readFileSync(path.resolve('supabase/functions/aem-sync-github/index.ts'), 'utf8');

  assert.match(publishFn, /token\.actions\.githubusercontent\.com/);
  assert.doesNotMatch(publishFn, /sb_publishable_|eyJhbGci/);
  assert.match(triggerFn, /constantTimeEqual/);
  assert.match(signingFn, /token\.actions\.githubusercontent\.com/);
  assert.match(signingFn, /signing_status:\s*["']failed["']/);
  assert.match(signingFn, /MAX_SIGNED_APK_BYTES/);
  assert.match(syncFn, /constantTimeEqual/);
  assert.match(syncFn, /MAX_WORKFLOW_ARCHIVE_BYTES_PER_REPO/);
  assert.match(syncFn, /cursor_repo_id/);
  assert.match(syncFn, /sanitizeWindowsIdentity/);
  assert.match(syncFn, /extractExeVersion/);
  assert.match(syncFn, /apkVariantKey/);
  assert.match(syncFn, /batch_active/);
  assert.match(syncFn, /wouldKeepApk/);
  assert.match(syncFn, /pruned_cache/);

  const pluginJava = fss.readFileSync(path.resolve('native/AemInstallerPlugin.java'), 'utf8');
  assert.match(pluginJava, /lastUpdateTime/);
  assert.match(pluginJava, /allowSameVersion/);
  assert.match(pluginJava, /handleOnResume/);
  assert.match(pluginJava, /ACTION_PACKAGE_REPLACED/);

  const mainKt = fss.readFileSync(path.resolve('app/src/main/java/com/aem/store/MainActivity.kt'), 'utf8');
  assert.match(mainKt, /optNullableLong/);
  assert.match(mainKt, /packageChangeReceiver/);
  assert.match(mainKt, /sourceUpdatedAtMs/);
});

test('Windows version resolution, Setup priority, and registry update comparisons work across non-semver and v-prefixed tags', async () => {
  const {selectLatestWindowsRelease} = await loadTs('src/domain/version.ts');
  const {windowsArtifacts, normalizeWindowsPackageIdentity, resolveWindowsVersion, appCardVersion} = await loadTs('src/domain/platform.ts');
  const {nativeUpdateState, validateNativeIdentity} = require('../dist-electron/native-registry.js');
  const {validateWindowsArtifact} = require('../dist-electron/native-delivery.js');

  assert.equal(normalizeWindowsPackageIdentity('github:Emmanuel001afk/EMA', 'com.ema.app'), 'com.ema.app');
  assert.equal(normalizeWindowsPackageIdentity('github:Emmanuel001afk/EMA'), 'github.Emmanuel001afk.EMA');
  assert.doesNotThrow(() => validateNativeIdentity(normalizeWindowsPackageIdentity('github:Emmanuel001afk/EMA')));

  const winArtifact = (filename, versionName, sourceUpdatedAt) => ({
    platform: 'windows',
    kind: 'exe',
    filename,
    versionName,
    sourceUpdatedAt,
    packageIdentity: 'com.aem.store',
    sha256: 'a'.repeat(64),
    downloadUrl: 'https://example.test/' + filename,
  });

  // Setup should sort ahead of Portable
  const ordered = windowsArtifacts({
    artifacts: [
      winArtifact('AEM-Store-Portable-x64.exe', '0.2.70', '2026-11-24T08:52:23Z'),
      winArtifact('AEM-Store-Setup-x64.exe', '0.2.70', '2026-11-24T08:52:23Z'),
    ],
  });
  assert.equal(ordered[0].filename, 'AEM-Store-Setup-x64.exe');

  // Non-semver workflow tag falls back cleanly when filename/versionName carries semver or timestamp
  const emaRelease = {
    id: '50',
    status: 'published',
    channel: 'stable',
    publishedAt: '2026-11-20T10:00:00Z',
    version: {name: 'workflow-11', code: 0},
    artifacts: [winArtifact('EMA-0.4.2-Setup-x64.exe', undefined, '2026-11-24T12:00:00Z')],
  };
  const olderWorkflow = {
    id: '40',
    status: 'published',
    channel: 'stable',
    publishedAt: '2026-11-10T10:00:00Z',
    version: {name: 'workflow-9', code: 0},
    artifacts: [winArtifact('EMA-Setup-x64.exe', undefined, '2026-11-10T10:00:00Z')],
  };
  const chosen = selectLatestWindowsRelease([olderWorkflow, emaRelease]);
  assert.equal(chosen.id, '50');
  assert.equal(resolveWindowsVersion(chosen, chosen.artifacts[0]), '0.4.2');
  assert.equal(resolveWindowsVersion({version: {name: 'v0.2.75'}}, {filename: 'Setup.exe'}), '0.2.75');

  assert.equal(nativeUpdateState([{packageIdentity: 'com.aem.store', displayName: 'AEM Store', version: '0.2.70', installLocation: '', scope: 'user'}], 'v0.2.75'), 'update');
  assert.equal(nativeUpdateState([{packageIdentity: 'com.aem.store', displayName: 'AEM Store', version: '0.2.75.0', installLocation: '', scope: 'user'}], 'v0.2.75'), 'current');
  assert.equal(nativeUpdateState([{packageIdentity: 'com.aem.store', displayName: 'AEM Store', version: '0.2.75', installLocation: '', scope: 'user'}], 'beta'), 'unknown');
  assert.doesNotThrow(() => validateWindowsArtifact({url: 'https://example.test/AEM-Setup.exe', filename: 'AEM-Setup.exe', sha256: 'a'.repeat(64), packageIdentity: 'com.aem.store', version: 'v0.2.75'}));

  const cardText = appCardVersion(
    {platforms: ['windows'], packageIdentity: 'com.aem.store', windowsLatest: {version: {name: 'v0.2.75'}, artifacts: [winArtifact('AEM-Store-Setup-x64.exe', '0.2.75', '2026-11-24T08:52:23Z')]}},
    'windows',
    undefined,
    {installed: [{version: '0.2.70'}], state: 'update'},
  );
  assert.match(cardText, /Installed 0\.2\.70 · Update available/);
});

test('loadSupabaseCatalog selects fresher equal-versionCode mutable releases and preserves ABI variants', async () => {
  const {loadSupabaseCatalog} = await loadTs('src/services/catalog/supabase.ts', [
    {
      id: 5,
      provider: 'github',
      project: 'Emmanuel001afk/OEA',
      name: 'OEA',
      package_identity: 'com.oea.launcher',
      platforms: ['android'],
      releases: [
        {
          id: 9,
          status: 'published',
          channel: 'stable',
          version_name: 'oea-latest',
          version_code: 9,
          published_at: '2026-10-03T10:00:00Z',
          artifacts: [{
            id: 963,
            platform: 'android',
            kind: 'apk',
            filename: 'OEA-latest.apk',
            download_url: 'https://example.test/OEA-latest.apk',
            sha256: '1'.repeat(64),
            package_identity: 'com.oea.launcher',
            version_code: 9,
            artifact_version_name: '1.0.9',
            signing_status: 'ready',
            source_updated_at: '2026-11-24T19:03:14Z',
          }],
        },
        {
          id: 8,
          status: 'published',
          channel: 'stable',
          version_name: 'oea-laptop-latest',
          version_code: 9,
          published_at: '2026-11-20T10:00:00Z',
          artifacts: [{
            id: 956,
            platform: 'android',
            kind: 'apk',
            filename: 'OEA-laptop-x86_64.apk',
            download_url: 'https://example.test/OEA-laptop-x86_64.apk',
            sha256: '2'.repeat(64),
            package_identity: 'com.oea.launcher',
            version_code: 9,
            artifact_version_name: '1.0.9',
            signing_status: 'ready',
            source_updated_at: '2026-11-24T19:03:17Z',
          }],
        },
      ],
    },
    {
      id: 2,
      provider: 'github',
      project: 'Emmanuel001afk/EMA',
      name: 'EMA',
      package_identity: 'com.ema.app',
      platforms: ['android'],
      releases: [
        {
          id: 21,
          status: 'published',
          channel: 'stable',
          version_name: 'old-tag',
          version_code: 100,
          published_at: '2026-11-20T00:00:00Z',
          artifacts: [{
            id: 201,
            platform: 'android',
            kind: 'apk',
            filename: 'ema-debug.apk',
            download_url: 'https://example.test/old-ema-debug.apk',
            sha256: '3'.repeat(64),
            package_identity: 'com.ema.app',
            version_code: 100,
            signing_status: 'ready',
            source_updated_at: '2026-11-20T00:00:00Z',
          }],
        },
        {
          id: 2,
          status: 'published',
          channel: 'stable',
          version_name: 'apk-latest',
          version_code: 100,
          published_at: '2026-10-13T00:00:00Z',
          artifacts: [{
            id: 202,
            platform: 'android',
            kind: 'apk',
            filename: 'ema-debug.apk',
            download_url: 'https://example.test/new-ema-debug.apk',
            sha256: '4'.repeat(64),
            package_identity: 'com.ema.app',
            version_code: 100,
            signing_status: 'ready',
            source_updated_at: '2026-11-24T10:22:25Z',
          }],
        },
      ],
    },
  ]);

  const catalog = await loadSupabaseCatalog();
  const oea = catalog.find((a) => a.name === 'OEA');
  const ema = catalog.find((a) => a.name === 'EMA');
  assert.equal(oea.androidReleases.length, 2);
  assert.equal(ema.latest.artifacts[0].downloadUrl, 'https://example.test/new-ema-debug.apk');
});
