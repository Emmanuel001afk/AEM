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

test('only explicitly named Windows release ZIPs are indexed as manual archives', async () => {
  const snippet=source.slice(source.indexOf('const artifactKind ='),source.indexOf('// OEA\'s games'));
  const {releaseArtifactKind,releasePlatform,artifactKind}=await loadSnippet(snippet+'\nexport {releaseArtifactKind,releasePlatform,artifactKind};');
  assert.equal(releaseArtifactKind('OEA-laptop-windows.zip'),'zip');
  assert.equal(releasePlatform('zip'),'windows');
  assert.equal(releaseArtifactKind('app-win64.zip'),'zip');
  assert.equal(releaseArtifactKind('android-source.zip'),null);
  assert.equal(artifactKind('OEA-laptop-windows.zip'),null);
});

test('do not extract onedir executables as misleading standalone downloads', async()=>{
 const snippet=source.slice(source.indexOf('const requiresAdjacentFiles ='),source.indexOf('async function archiveBinaries'));
 const {requiresAdjacentFiles}=await loadSnippet(snippet+'\nexport {requiresAdjacentFiles};');
 const files=['EMA.exe','_internal/python.dll','worker/EMA-worker.exe','worker/_internal/base_library.zip'];
 assert.equal(requiresAdjacentFiles('EMA.exe',files),true);
 assert.equal(requiresAdjacentFiles('worker/EMA-worker.exe',files),true);
 assert.equal(requiresAdjacentFiles('Setup.exe', ['Setup.exe','README.txt']),false);
 assert.equal(requiresAdjacentFiles('installer/Setup.exe',files),false);
});

test('large public source APKs retain their calculated digest and source signing identity',()=>{
 assert.match(source,/externalDigest = await sha256\(bytes\)/);
 assert.match(source,/digest !== externalDigest/);
 assert.match(source,/digest: externalDigest, external: true/);
 assert.match(source,/signing_status: "ready", signing_authority: "source"/);
});

test('large APK metadata inspection uses bounded ranges and rejects unsupported or corrupt responses',async()=>{
 const {default:yazl}=await import('yazl');
 const zip=new yazl.ZipFile();
 zip.addBuffer(Buffer.from('manifest-fixture'),'AndroidManifest.xml',{compress:false});
 zip.addBuffer(Buffer.from('signature-fixture'),'META-INF/CERT.RSA',{compress:false});
 zip.end();
 const chunks=[]; for await (const chunk of zip.outputStream) chunks.push(chunk);
 const bytes=Buffer.concat(chunks), original=globalThis.fetch, requests=[];
 globalThis.fetch=async (_url,init)=>{
  const match=/^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);assert.ok(match);
  const start=Number(match[1]),end=Number(match[2]);requests.push([start,end]);
  return new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`}});
 };
 try {
  const snippet=source.slice(source.indexOf('async function inspectPublicApkRanges('),source.indexOf('async function apkMetadata('));
  const {inspectPublicApkRanges}=await loadSnippet('const MAX_MANIFEST_BYTES=16*1024*1024; const parseApkManifest=()=>({packageName:"org.example",versionCode:9}); const inflateBounded=async()=>null;\n'+snippet+'\nexport {inspectPublicApkRanges};');
  assert.equal((await inspectPublicApkRanges('https://example.test/a.apk',bytes.length)).packageName,'org.example');
  assert.ok(requests.length>=3);
  globalThis.fetch=async()=>new Response(bytes,{status:200});
  await assert.rejects(inspectPublicApkRanges('https://example.test/a.apk',bytes.length),/range/);
  globalThis.fetch=async()=>new Response('x',{status:206,headers:{'content-range':`bytes 0-${bytes.length-1}/${bytes.length}`}});
  await assert.rejects(inspectPublicApkRanges('https://example.test/a.apk',bytes.length),/Truncated/);
  await assert.rejects(inspectPublicApkRanges('https://example.test/a.apk',0x100000000),/ZIP64/);
 } finally {globalThis.fetch=original;}
});

test('large private EXEs use a GitHub release gateway instead of Supabase Storage',()=>{
 assert.match(source,/kind === "exe" && repo\.private && size > 50\*1024\*1024/);
 assert.match(source,/source_kind:"release_asset",github_id:asset\.id/);
 assert.match(source,/private EXE requires an asset ID and SHA-256/);
});

test('AEM-produced source EXEs are associated only with their intended application',async()=>{
 const snippet=source.slice(source.indexOf('const AEM_EXE_SOURCE_REPOS:'),source.indexOf('// Bound API work'));
 const {aemExeReleaseMatches,isAemExeRelease}=await loadSnippet(snippet+'\nexport {aemExeReleaseMatches,isAemExeRelease};');
 const ema={tag_name:'aem-exe-ema-'+ 'a'.repeat(40)+'-'+ 'b'.repeat(12)};
 const oea={tag_name:'aem-exe-oea-'+ 'c'.repeat(40)+'-'+ 'd'.repeat(12)};
 assert.equal(aemExeReleaseMatches('Emmanuel001afk/EMA',ema),true);
 assert.equal(aemExeReleaseMatches('Emmanuel001afk/OEA',ema),false);
 assert.equal(aemExeReleaseMatches('Emmanuel001afk/OEA',oea),true);
 assert.equal(aemExeReleaseMatches('Emmanuel001afk/AEM',ema),false);
 assert.equal(aemExeReleaseMatches('Emmanuel001afk/EMA',{...ema,draft:true}),false);
 assert.equal(aemExeReleaseMatches('Emmanuel001afk/EMA',{...ema,prerelease:true}),false);
 assert.equal(isAemExeRelease(ema),true);
 assert.equal(isAemExeRelease({tag_name:'aem-exe-ema-../../x'}),false);
});
