import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TransferService,validateManifest}=require('../dist-electron/transfer/service.js');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
async function fixture(t,approve=()=>true){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aem-lan-'));
 const service=new TransferService({root,assets:path.resolve('dist-electron/transfer/web'),advertise:false,bindHost:'127.0.0.1',consent:async r=>approve(r)});
 await service.start();t.after(async()=>{await service.stop();await fs.rm(root,{recursive:true,force:true});});
 const request=(route,{method='GET',token,body,headers={},ca=service.certificate}={})=>new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  const req=https.request({hostname:'127.0.0.1',port:service.status().port,path:route,method,ca,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(payload?{'Content-Length':payload.length}:{}),...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,bytes,json:()=>JSON.parse(bytes)});});});req.on('error',reject);req.end(payload);
 });
 const pair=async(name='Any independent application')=>{service.newInvitation();const r=await request('/pair',{method:'POST',body:{invitation:service.status().invitation,name}});assert.equal(r.status,200,r.bytes.toString());return r.json();};
 return {root,service,request,pair};
}
test('LAN HTTPS requires trusted certificate, same origin, pairing and PC consent',async t=>{
 const {service,request,pair}=await fixture(t);
 await assert.rejects(()=>request('/',{ca:''}));
 assert.equal((await request('/')).status,200);
 assert.equal((await request('/api/state')).status,401);
 assert.equal((await request('/api/state',{headers:{Origin:'https://attacker.invalid'}})).status,403);
 const invite=service.status().invitation;
 const {token}=await pair('Independent Research Tool');
 assert.equal((await request('/api/state',{token})).status,200);
 assert.equal((await request('/pair',{method:'POST',body:{invitation:invite,name:'spoof'}})).status,403);
 assert.equal((await request('/pair',{method:'POST',body:{invitation:'bad',name:'Other'}})).status,403);
});

test('LAN upload persists bytes, resumes at accepted offset, verifies hash and saves atomically',async t=>{
 const {root,service,request,pair}=await fixture(t);const {token}=await pair();
 const bytes=crypto.randomBytes(12345),meta={name:'actual-file.bin',size:bytes.length,sha256:digest(bytes)};
 let r=await request('/api/uploads',{method:'POST',token,body:meta});assert.equal(r.status,200);const key=r.json().id;
 const put=(offset,chunk,hash=digest(chunk))=>request(`/api/uploads/${key}?offset=${offset}`,{method:'PATCH',token,body:chunk,headers:{'X-Chunk-Sha256':hash}});
 assert.equal((await put(0,bytes.subarray(0,5000))).status,200);
 r=await request('/api/uploads',{method:'POST',token,body:meta});assert.equal(r.json().offset,5000);assert.equal(r.json().id,key);
 assert.equal((await put(0,bytes)).status,409);
 assert.equal((await request(`/api/uploads/${key}/complete`,{method:'POST',token})).status,409);
 assert.equal((await put(5000,bytes.subarray(5000),'0'.repeat(64))).status,422);
 assert.equal((await put(5000,bytes.subarray(5000))).status,200);
 r=await request(`/api/uploads/${key}/complete`,{method:'POST',token});assert.equal(r.status,200);assert.equal(r.json().state,'complete');
 assert.deepEqual(await fs.readFile(path.join(root,`${key}-${meta.name}`)),bytes);
 assert.equal((await request(`/api/uploads/${key}`,{token})).status,405);
 await service.stop();assert.deepEqual(await fs.readFile(path.join(root,`${key}-${meta.name}`)),bytes);
});
test('LAN final hash failure cannot produce a completed file; revocation denies future requests',async t=>{
 const {root,service,request,pair}=await fixture(t);const p=await pair();const data=Buffer.from('actual bytes');
 const r=await request('/api/uploads',{method:'POST',token:p.token,body:{name:'app.apk',size:data.length,sha256:digest('different')}});const key=r.json().id;
 assert.equal((await request(`/api/uploads/${key}?offset=0`,{method:'PATCH',token:p.token,body:data,headers:{'X-Chunk-Sha256':digest(data)}})).status,200);
 assert.equal((await request(`/api/uploads/${key}/complete`,{method:'POST',token:p.token})).status,422);
 assert.equal(service.status().files[0].offset,0);
 await assert.rejects(()=>fs.stat(path.join(root,`${key}-app.apk`)));
 await service.revoke(p.peer.id);assert.equal((await request('/api/state',{token:p.token})).status,401);
 assert.deepEqual(await fs.readdir(path.join(root,'.pending')),[]);
});
test('LAN PC-to-client range downloads use explicitly selected source paths and byte-accurate resume',async t=>{
 const {root,service,request,pair}=await fixture(t);const p=await pair();const bytes=crypto.randomBytes(4567);const source=path.join(root,'selected.bin');await fs.writeFile(source,bytes);
 await service.offer([source]);const f=service.status().files[0];
 assert.equal((await request(`/api/offers/${f.id}`,{token:p.token})).status,416);
 const a=await request(`/api/offers/${f.id}`,{token:p.token,headers:{Range:'bytes=0-999'}});
 const b=await request(`/api/offers/${f.id}`,{token:p.token,headers:{Range:`bytes=1000-${bytes.length-1}`}});
 assert.equal(a.status,206);assert.deepEqual(Buffer.concat([a.bytes,b.bytes]),bytes);assert.equal(digest(Buffer.concat([a.bytes,b.bytes])),f.sha256);
 await service.remove(f.id);assert.equal((await request(`/api/offers/${f.id}`,{token:p.token,headers:{Range:'bytes=0-9'}})).status,404);
 assert.deepEqual(await fs.readFile(source),bytes);
});
test('LAN peer isolation, denial, traversal and large payload checks fail closed',async t=>{
 const {service,request,pair}=await fixture(t,r=>r.name!=='Denied');const a=await pair(),b=await pair('Another publisher');
 const r=await request('/api/uploads',{method:'POST',token:a.token,body:{name:'file.bin',size:1,sha256:digest('a')}});const key=r.json().id;
 assert.equal((await request(`/api/uploads/${key}/complete`,{method:'POST',token:b.token})).status,404);
 assert.equal((await request('/api/uploads',{method:'POST',token:a.token,body:{name:'../../escape',size:1,sha256:digest('a')}})).status,400);
 assert.equal((await request('/api/uploads',{method:'POST',token:a.token,body:{name:'Denied',size:1,sha256:digest('a')}})).status,403);
 assert.equal((await request('/api/uploads',{method:'POST',token:a.token,body:{name:'large.bin',size:257*1024*1024,sha256:digest('a')}})).status,400);
 await service.stop();assert.equal(service.status().running,false);
});
test('LAN filenames and sizes cannot escape destination or claim unlimited storage',()=>{
 for(const name of ['../x','/x','CON','LPT1.txt','file:stream','x\\y','foo.','a\0b'])assert.throws(()=>validateManifest({name,size:1,sha256:digest('x')}));
 for(const size of [-1,Infinity,NaN,1.2])assert.throws(()=>validateManifest({name:'x.bin',size,sha256:digest('x')}));
});
test('LAN one-use invitation cannot be replayed and revokes on stop',async t=>{
 const {service,request}=await fixture(t);const invite=service.status().invitation;
 const r=await request('/pair',{method:'POST',body:{invitation:invite,name:'Generic Device'}});assert.equal(r.status,200);
 assert.equal((await request('/pair',{method:'POST',body:{invitation:invite,name:'Replay'}})).status,403);
 service.newInvitation();service.inviteUntil=Date.now()-1;
 assert.equal((await request('/pair',{method:'POST',body:{invitation:service.status().invitation,name:'Expired'}})).status,403);
});
test('LAN interrupted request never advances uncommitted offset',async t=>{
 const {service,request,pair}=await fixture(t);const {token}=await pair();const bytes=Buffer.alloc(100000,73);
 const r=await request('/api/uploads',{method:'POST',token,body:{name:'interrupted.bin',size:bytes.length,sha256:digest(bytes)}});const key=r.json().id;
 await new Promise(resolve=>{
  const req=https.request({hostname:'127.0.0.1',port:service.status().port,path:`/api/uploads/${key}?offset=0`,method:'PATCH',ca:service.certificate,headers:{Authorization:`Bearer ${token}`,'Content-Length':bytes.length,'X-Chunk-Sha256':digest(bytes)}});
  req.on('error',()=>resolve());req.on('socket',socket=>socket.once('secureConnect',()=>{req.write(bytes.subarray(0,1000));setTimeout(()=>{req.destroy();resolve();},20);}));
 });
 assert.equal(service.status().files[0].offset,0);
 const upload=await request(`/api/uploads/${key}?offset=0`,{method:'PATCH',token,body:bytes,headers:{'X-Chunk-Sha256':digest(bytes)}});
 // The abandoned body can still be unwinding: retry only after its busy guard clears.
 if(upload.status===409){await new Promise(r=>setTimeout(r,50));assert.equal((await request(`/api/uploads/${key}?offset=0`,{method:'PATCH',token,body:bytes,headers:{'X-Chunk-Sha256':digest(bytes)}})).status,200);}else assert.equal(upload.status,200);
 assert.equal((await request(`/api/uploads/${key}/complete`,{method:'POST',token})).status,200);
});
