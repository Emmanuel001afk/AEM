import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync('supabase/functions/aem-sync-github/index.ts', 'utf8');
async function loadSnippet(text) {
  const js = ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}

test('APK retention separates debug, release, architecture and package identity', async () => {
  const snippet = source.slice(source.indexOf('const apkVariantKey ='), source.indexOf('const sourceTimestampForOrdering'));
  const {apkVariantKey} = await loadSnippet(snippet + '\nexport {apkVariantKey};');
  assert.notEqual(apkVariantKey('app-debug.apk','com.example'), apkVariantKey('app-release.apk','com.example'));
  assert.notEqual(apkVariantKey('app-x86_64-release.apk','com.example'), apkVariantKey('app-release.apk','com.example'));
  assert.notEqual(apkVariantKey('app-release.apk','com.example'), apkVariantKey('app-release.apk','com.other'));
});

test('release discovery reads later pages and reports an exhausted bound', async () => {
  const snippet = source.slice(source.indexOf('async function githubReleasePages('), source.indexOf('function previousFailures('));
  const {githubReleasePages} = await loadSnippet('const GH="https://api.github.test"; const gh=(url, headers)=>globalThis.__releasePage(url, headers);\n' + snippet + '\nexport {githubReleasePages};');
  const calls=[];
  globalThis.__releasePage=async url=>{calls.push(url);return calls.length===1?Array.from({length:100},(_,i)=>i):['older-release'];};
  const found=await githubReleasePages('org/repo',{});
  assert.equal(found.items.length,101);
  assert.equal(found.items.at(-1),'older-release');
  assert.equal(found.truncated,false);
  assert.match(calls[1],/page=2/);
  let count=0;globalThis.__releasePage=async()=>{count++;return Array(100).fill('release');};
  assert.equal((await githubReleasePages('org/repo',{})).truncated,true);
  assert.equal(count,5);
  delete globalThis.__releasePage;
});
