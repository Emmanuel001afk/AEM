#!/usr/bin/env node
/** Package EMA's complete PyInstaller onedir distribution as one Windows EXE.
 * The input is built and smoke-tested by EMA's own Windows build, not an APK.
 * This script does not publish, sign, or attest the output. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const exec=promisify(execFile);
const require=createRequire(import.meta.url);

export async function validateEmaDistribution(dir) {
  const root=await fs.realpath(dir);
  for (const relative of ['EMA.exe','_internal','worker/EMA-worker.exe','worker/_internal']) {
    const target=await fs.realpath(path.join(root,relative)).catch(()=>{throw new Error(`EMA distribution is incomplete: missing ${relative}`)});
    const within=path.relative(root,target);
    if (!within || within.startsWith('..'+path.sep) || path.isAbsolute(within)) throw new Error(`EMA distribution entry escapes its root: ${relative}`);
    const stat=await fs.stat(target);
    if (relative.endsWith('.exe')) {
      if (!stat.isFile()) throw new Error(`Expected an executable file: ${relative}`);
      const handle=await fs.open(target,'r');
      try {const bytes=Buffer.alloc(2);const read=await handle.read(bytes,0,2,0);if(read.bytesRead!==2||bytes.toString('ascii')!=='MZ')throw new Error(`Not a Windows executable: ${relative}`);} finally {await handle.close();}
    } else if (!stat.isDirectory()) throw new Error(`Expected a support directory: ${relative}`);
  }
  return root;
}

export async function packageEma({distribution,version,makensis,outputDir}) {
  if (process.platform!=='win32') throw new Error('Building the EMA installer requires Windows and NSIS');
  if (!/^\d+\.\d+\.\d+$/.test(version||'') || version.split('.').some(part=>Number(part)>65535)) throw new Error('EMA version must be a numeric Windows-compatible triple');
  const root=await validateEmaDistribution(distribution);
  const outDir=path.resolve(outputDir);await fs.mkdir(outDir,{recursive:true});
  const output=path.join(outDir,`EMA-Setup-${version}-x64.exe`);
  const script=path.join(outDir,'ema-setup.nsi');
  const {installerScript}=require('../dist-electron/native-delivery.js');
  const recipe={schema:1,familyId:'com.ema.assistant',windowsAppId:'com.ema.assistant',displayName:'EMA',version,project:'EMA.csproj',executable:'EMA.exe',sourceRevision:'EMA Windows distribution',license:'See included EMA notices'};
  await fs.writeFile(script,installerScript(recipe,root,output));
  await exec(makensis,[script],{timeout:10*60*1000,maxBuffer:8*1024*1024,windowsHide:true});
  const handle=await fs.open(output,'r');
  try {const buf=Buffer.alloc(2);const result=await handle.read(buf,0,2,0);if(result.bytesRead!==2||buf.toString('ascii')!=='MZ')throw new Error('NSIS did not produce a Windows executable');} finally {await handle.close();}
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [distribution,version,makensis,outputDir]=process.argv.slice(2);
  if (!distribution||!version||!makensis||!outputDir) {console.error('Usage: node scripts/package-ema.mjs <complete-ema-directory> <version> <makensis> <output-directory>');process.exitCode=2;}
  else packageEma({distribution,version,makensis,outputDir}).then(file=>console.log(file)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
