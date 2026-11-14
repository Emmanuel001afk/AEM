import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PhoneManager}=require('../dist-electron/phone.js');
const {extractPackage}=require('../dist-electron/emulator/packages.js');
// Explicit ADB test double. Exercises real subprocess/stream/hash/ZIP code, NOT a physical phone.
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aem-adb-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const adb=path.join(root,'adb');
  fs.writeFileSync(adb,`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=__dirname;
const remote=p=>path.join(root,'remote',p);
let a=process.argv.slice(2);
if(a[0]==='devices'){console.log('List of devices attached\\nphone123\\t'+(fs.existsSync(path.join(root,'unauthorized'))?'unauthorized':'device')+' model:Test_Phone');process.exit(0);}
if(a[0]!=='-s'||a[1]!=='phone123')process.exit(1);
a=a.slice(2);
if(a[0]==='pull'){fs.copyFileSync(remote(a[1]),a[2]);process.exit(0);}
if(a[0]==='push'){fs.mkdirSync(path.dirname(remote(a[2])),{recursive:true});fs.copyFileSync(a[1],remote(a[2]));if(fs.existsSync(path.join(root,'tamper')))fs.appendFileSync(remote(a[2]),'tampered');process.exit(0);}
if(a[0]==='shell'){
 const cmd=a[1];
 if(cmd==='pm list packages -3'){console.log('package:com.example.app');process.exit(0);}
 if(cmd==='pm path com.example.app'){console.log('package:/data/app/~~set/com.example/base.apk\\npackage:/data/app/~~set/com.example/config.en.apk');process.exit(0);}
 const parts=[...cmd.matchAll(/'([^']+)'/g)].map(m=>m[1]);
 if(cmd.startsWith('toybox sha256sum ')){const h=crypto.createHash('sha256').update(fs.readFileSync(remote(parts[0]))).digest('hex');console.log(h+'  '+parts[0]);process.exit(0);}
 if(cmd.startsWith('mkdir -p ')){fs.mkdirSync(remote(cmd.slice(9)),{recursive:true});process.exit(0);}
 if(cmd.startsWith('mv ')){fs.renameSync(remote(parts[0]),remote(parts[1]));process.exit(0);}
 if(cmd.startsWith('rm -f ')){fs.rmSync(remote(parts[0]),{force:true});process.exit(0);}
}
process.exit(1);
`,{mode:0o755});
  const downloads=path.join(root,'downloads');
  const manager=new PhoneManager(adb,null,downloads);
  const writeRemote=(file,bytes)=>{const p=path.join(root,'remote',file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);};
  return {root,manager,downloads,writeRemote};
}
test('authorized ADB double: send and receive verify bytes and hashes',{skip:process.platform==='win32'},async t=>{
  const {root,manager}=fixture(t);const local=path.join(root,'selected.apks');fs.writeFileSync(local,'transport payload');
  const sent=await manager.push('phone123',local);assert.match(sent.sha256,/^[a-f0-9]{64}$/);assert.equal(manager.status().progress.phase,'complete');
  const received=await manager.pull('phone123',sent.path);assert.equal(received.sha256,sent.sha256);assert.equal(fs.readFileSync(received.path,'utf8'),'transport payload');
});
test('authorized ADB double: corrupted send is rejected and partial file removed',{skip:process.platform==='win32'},async t=>{
  const {root,manager}=fixture(t);const local=path.join(root,'input.apk');fs.writeFileSync(local,'bytes');fs.writeFileSync(path.join(root,'tamper'),'1');
  await assert.rejects(manager.push('phone123',local),/SHA-256 mismatch/);assert.equal(manager.status().progress.phase,'failed');
  assert.deepEqual(fs.readdirSync(path.join(root,'remote/sdcard/Download/AEM-Transfer')),[]);
});
test('unauthorized ADB double: cannot transfer or start display',{skip:process.platform==='win32'},async t=>{
  const {root,manager}=fixture(t);fs.writeFileSync(path.join(root,'unauthorized'),'1');
  await assert.rejects(manager.push('phone123','file'),/approve/);await assert.rejects(manager.start('phone123'),/approve/);
});
test('authorized ADB double: exported collection includes base and all accessible splits',{skip:process.platform==='win32'},async t=>{
  const {root,manager,writeRemote}=fixture(t);writeRemote('/data/app/~~set/com.example/base.apk','base bytes');writeRemote('/data/app/~~set/com.example/config.en.apk','split bytes');
  const exported=await manager.exportPackage('phone123','com.example.app');assert.equal(exported.components,2);assert.equal(manager.status().progress.completed,2);
  const staging=path.join(root,'extracted');fs.mkdirSync(staging);const files=await extractPackage(exported.path,staging);assert.deepEqual(files.map(f=>fs.readFileSync(f,'utf8')),['base bytes','split bytes']);
});
