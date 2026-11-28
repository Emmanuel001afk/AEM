import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const yaml=createRequire(import.meta.url)('js-yaml');
test('source EXE workflow builds both applications and publishes only after success on main',()=>{
 const workflow=yaml.load(fs.readFileSync('.github/workflows/aem-source-windows-exe.yml','utf8'));
 assert.deepEqual(workflow.jobs.build.strategy.matrix.app,['EMA','OEA']);
 assert.match(workflow.jobs.publish.if,/refs\/heads\/main/);
 assert.equal(workflow.jobs.publish.needs,'build');
 assert.equal(workflow.jobs.publish.permissions.contents,'write');
 const text=fs.readFileSync('.github/workflows/aem-source-windows-exe.yml','utf8');
 assert.match(text,/EMA-worker\.exe/);assert.match(text,/--self-test/);
 assert.match(text,/gh release create/);assert.match(text,/--latest=false/);
 assert.doesNotMatch(text,/supabase\.co\/storage/);
});
