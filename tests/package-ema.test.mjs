import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateEmaDistribution} from '../scripts/package-ema.mjs';

test('EMA packaging refuses an isolated EXE or an incomplete worker',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aem-ema-package-'));
 try {
  await fs.writeFile(path.join(dir,'EMA.exe'),'MZ');
  await assert.rejects(validateEmaDistribution(dir),/incomplete/);
  await fs.mkdir(path.join(dir,'_internal'));await fs.mkdir(path.join(dir,'worker'));
  await fs.writeFile(path.join(dir,'worker','EMA-worker.exe'),'MZ');
  await assert.rejects(validateEmaDistribution(dir),/worker\/_internal/);
  await fs.mkdir(path.join(dir,'worker','_internal'));
  assert.equal(await validateEmaDistribution(dir),await fs.realpath(dir));
  await fs.writeFile(path.join(dir,'EMA.exe'),'not an exe');
  await assert.rejects(validateEmaDistribution(dir),/Not a Windows executable/);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
