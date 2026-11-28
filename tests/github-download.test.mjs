import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const text=fs.readFileSync('supabase/functions/aem-github-download/index.ts','utf8')
  .replace('import {createClient} from "npm:@supabase/supabase-js@2";', 'const createClient=(...args)=>globalThis.__downloadClient(...args);');
const compiled=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
let handler;
globalThis.Deno={env:{get:name=>({SUPABASE_URL:'https://example.test',SUPABASE_SERVICE_ROLE_KEY:'service-key',AEM_GITHUB_TOKEN:'secret-token'}[name])},serve:fn=>{handler=fn}};
await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const originalFetch=globalThis.fetch;
const row={repo:'owner/private',source_kind:'release_asset',github_id:123,expires_at:null,artifacts:{id:7,signing_status:'ready',releases:{status:'published'}}};
let current=row;
globalThis.__downloadClient=()=>({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:current,error:null})})})})});

test('gateway redirects only published catalogued files and never exposes the GitHub token',async()=>{
 let called;
 globalThis.fetch=async(url,opts)=>{called={url,opts};return new Response(null,{status:302,headers:{location:'https://objects.example/signed-file'}})};
 try {
  current=row;
  const result=await handler(new Request('https://example.test?id=7'));
  assert.equal(result.status,302);assert.equal(result.headers.get('location'),'https://objects.example/signed-file');
  assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(called.opts.redirect,'manual');
  assert.equal(called.opts.headers.Authorization,'Bearer secret-token');
  assert.equal(JSON.stringify([...result.headers]).includes('secret-token'),false);
  assert.match(called.url,/repos\/owner\/private\/releases\/assets\/123$/);
  assert.equal((await handler(new Request('https://example.test?id=abc'))).status,400);
  current={...row,artifacts:{...row.artifacts,releases:{status:'withdrawn'}}};
  assert.equal((await handler(new Request('https://example.test?id=7'))).status,404);
  current={...row,expires_at:'2000-01-01T00:00:00Z'};
  assert.equal((await handler(new Request('https://example.test?id=7'))).status,410);
  current=row;
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'http://objects.example/file'}});
  assert.equal((await handler(new Request('https://example.test?id=7'))).status,502);
 } finally {globalThis.fetch=originalFetch;}
});

test('Actions archives use the GitHub API media type and expire safely',async()=>{
 let options;
 globalThis.fetch=async(_url,opts)=>{options=opts;return new Response(null,{status:302,headers:{location:'https://objects.example/action.zip'}})};
 try {
  current={...row,source_kind:'actions_artifact',expires_at:'2099-01-01T00:00:00Z'};
  assert.equal((await handler(new Request('https://example.test?id=7'))).status,302);
  assert.equal(options.headers.Accept,'application/vnd.github+json');
 } finally {globalThis.fetch=originalFetch;current=row;}
});
