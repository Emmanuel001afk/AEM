import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';

const source = fs.readFileSync('src/services/downloads/manager.ts', 'utf8')
  .replace('import {supabaseRequest} from "../supabase/client";', 'const supabaseRequest = (...args) => globalThis.__storeRequest(...args);');
const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
const downloads = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true});
const values = new Map();
globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};
const task = {appId: '1', releaseId: '2', filename: 'app.apk', url: 'https://example.com/app.apk', status: 'downloading', bytesDownloaded: 0};

test('failed history request falls back to a locally updateable download', async () => {
  values.clear();
  globalThis.__storeRequest = async () => { throw new Error('offline'); };
  const row = await downloads.recordDownload(task);
  assert.match(row.id, /^local-/);
  assert.equal(row.local_only, true);
  await downloads.updateDownload(row.id, {status: 'installing', bytesDownloaded: 32});
  globalThis.__storeRequest = async () => ({ok: true, json: async () => []});
  const [saved] = await downloads.listDownloads();
  assert.equal(saved.status, 'installing');
  assert.equal(saved.bytes_downloaded, 32);
  await downloads.updateDownload(row.id, {status: 'completed', installedVersionCode: 5});
  const [completed] = await downloads.listDownloads();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.installed_version_code, 5);
});

test('server rejection falls back, but invalid URLs remain rejected', async () => {
  values.clear();
  globalThis.__storeRequest = async () => ({ok: false, status: 503});
  assert.equal((await downloads.recordDownload(task)).local_only, true);
  await assert.rejects(downloads.recordDownload({...task, url: 'http://example.com/app.apk'}), /HTTPS/);
});

test('successful history writes use the server record', async () => {
  values.clear();
  globalThis.__storeRequest = async () => ({ok: true, json: async () => [{id: 42, status: 'downloading'}]});
  assert.equal((await downloads.recordDownload(task)).id, 42);
  assert.equal(values.has('aem-local-downloads'), false);
});
