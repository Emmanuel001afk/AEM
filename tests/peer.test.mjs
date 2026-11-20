import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const fss=require('node:fs');
const {PeerTransferService}=require('../dist-electron/transfer/peer.js');
const {signPeerRequest,PEER_HEADER}=require('../dist-electron/transfer/protocol.js');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const rid=()=>crypto.randomBytes(16).toString('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(what,check,timeout=30000){const started=Date.now();for(;;){const v=check();if(v)return v;if(Date.now()-started>timeout)throw new Error(`timed out waiting for ${what}`);await sleep(30);}}

/** Two real PeerTransferService instances over loopback, already paired. Nothing is mocked: TLS,
 * HMAC signatures, per-chunk hashing, consent callbacks and file writes all run for real. */
async function fixture(t,{receive=true}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aem-peer-'));
 const make=async(name,consent)=>{const svc=new PeerTransferService({root:path.join(dir,name),stateDir:path.join(dir,name,'state'),advertise:false,bindHost:'127.0.0.1',consent});await svc.start();return svc;};
 const alice=await make('alice',async r=>r.kind==='receive'?(typeof receive==='function'?receive(r):receive):true);
 const bob=await make('bob',async()=>true);
 t.after(async()=>{try{await alice.stop();}catch{}try{await bob.stop();}catch{}await fs.rm(dir,{recursive:true,force:true});});
 const invitation=(await alice.newInvite()).invitation;
 await bob.pairWith(invitation);
 /** Sign and send one raw request. `target` is a paired peer id or an explicit {address,port}. */
 const call=(svc,target,method,route,body=Buffer.alloc(0),o={})=>{
  const peer=typeof target==='string'?svc.peers.get(target):null;
  if(typeof target==='string'&&!peer)throw new Error(`this PC has no record of peer ${target}`);
  const address=peer?.address??target.address,port=peer?.port??target.port;
  const payload=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  const headers={'X-AEM-Port':String(svc.status().port),...o.headers};
  if(o.header)headers[PEER_HEADER]=o.header;
  else if(!o.skipAuth)headers[PEER_HEADER]=signPeerRequest(o.secret??peer?.secret??digest('no key'),{method,route,body:payload,from:o.from??svc.identity.id,ts:o.ts??Date.now(),nonce:o.nonce??rid()});
  return new Promise((resolve,reject)=>{
   const req=https.request({host:address,port,path:route,method,...(peer&&!o.insecure?{ca:peer.cert,rejectUnauthorized:true}:{rejectUnauthorized:false,checkServerIdentity:()=>undefined}),key:svc.identity.key,cert:svc.identity.cert,headers:{...headers,'Content-Length':String(payload.length)}},res=>{const c=[];res.on('data',b=>c.push(b));res.on('end',()=>{const bytes=Buffer.concat(c);resolve({status:res.statusCode,headers:res.headers,body:bytes,text:bytes.toString(),json:()=>JSON.parse(bytes.toString())});});});
   req.on('error',reject);req.setTimeout(20000,()=>req.destroy(new Error('test timeout')));req.end(payload);
  });
 };
 return {dir,alice,bob,invitation,call};
}

test('pairing consumes the exact invitation, pins certificates and confirms one code on both PCs',async t=>{
 const f=await fixture(t);
 const [ap]=f.alice.status().peers,[bp]=f.bob.status().peers;
 assert.match(ap.sas,/^\d{6}$/);
 assert.equal(ap.sas,bp.sas,'both PCs must display the same 6-digit confirmation code');
 assert.equal(ap.name,f.bob.status().name,'the label shown on Alice is what Bob declared');
 assert.equal(bp.name,f.alice.status().name);
 assert.equal(ap.fingerprint,f.bob.identity.fingerprint);
 assert.equal(bp.fingerprint,f.alice.identity.fingerprint);
 // The invitation is one-use: it is cleared the moment a pairing is approved.
 assert.equal(f.alice.status().invitation,null);
 await assert.rejects(()=>f.bob.pairWith(f.invitation),/already paired/i);
 await assert.rejects(()=>f.bob.pairWith('AEM1-please-no'),/not a valid AEM PC invitation/i);
 // A code that points at a closed port never pairs, and a stale invitation never pairs either.
 await assert.rejects(()=>f.bob.pairWith(`AEM1-${Buffer.from(JSON.stringify({v:1,i:rid(),h:'127.0.0.1',p:1,f:'0'.repeat(64),t:'x'.repeat(40)})).toString('base64url')}`),/refused|reset|timed out|unreachable/i);
 const own=(await f.alice.newInvite()).invitation;
 await assert.rejects(()=>f.alice.pairWith(own),/own invitation/i);
 f.alice.inviteUntil=Date.now()-1;
 const stranger=new PeerTransferService({root:path.join(f.dir,'stranger'),stateDir:path.join(f.dir,'stranger-state'),advertise:false,bindHost:'127.0.0.1',consent:async()=>true});
 await stranger.start();t.after(async()=>{try{await stranger.stop();}catch{}});
 await assert.rejects(()=>stranger.pairWith(own),/expired|no longer active/i);
 // Nothing is readable without pairing, no matter how the request is signed.
 const anon=await f.call(stranger,{address:'127.0.0.1',port:f.alice.status().port},'GET','/peer/state',Buffer.alloc(0),{skipAuth:true,insecure:true});
 assert.equal(anon.status,401);
 assert.equal((await f.call(f.bob,bp.id,'GET','/peer/state',Buffer.alloc(0),{secret:digest('not the pairing key')})).status,403);
 // The peer server never serves the browser companion's assets or endpoints, and it does not even
 // reveal which routes exist: everything but presence/pairing demands a valid pairing signature.
 assert.equal((await f.call(f.bob,bp.id,'GET','/',Buffer.alloc(0),{skipAuth:true})).status,401);
 assert.equal((await f.call(f.bob,bp.id,'POST','/api/uploads',{name:'x',size:1,sha256:digest('a')},{skipAuth:true})).status,401);
 assert.equal((await f.call(f.bob,bp.id,'POST','/api/uploads',{name:'x',size:1,sha256:digest('a')},{})).status,404,'a paired PC still gets no unknown route');
 assert.equal((await f.call(f.bob,bp.id,'GET','/client.js',Buffer.alloc(0),{skipAuth:true})).status,401);
});

test('paired PCs transfer files both ways with chunk hashes, whole-file verification and atomic save',async t=>{
 const f=await fixture(t);
 const source=path.join(f.dir,'payload.bin');
 const bytes=Buffer.concat([crypto.randomBytes(2*1024*1024),Buffer.from('tail bytes')]);
 await fs.writeFile(source,bytes);
 await f.bob.send(f.alice.status().id,[source]);
 const received=await until('Bob → Alice completion',()=>f.alice.status().transfers.find(x=>['complete','failed','declined'].includes(x.state)));
 assert.equal(received.state,'complete',received.error??'');
 assert.equal(received.direction,'receive');
 assert.equal(received.peerName,f.bob.status().name);
 assert.equal(received.sha256,digest(bytes));
 assert.equal(received.offset,bytes.length);
 const saved=path.join(f.alice.status().receiveDir,`${received.id}-payload.bin`);
 assert.deepEqual(await fs.readFile(saved),bytes,'the saved bytes must equal the source bytes');
 assert.deepEqual(await fs.readdir(path.join(f.alice.status().receiveDir,'.pending')),[],'no partial may survive finalization');
 await until('sender row',()=>f.bob.status().transfers.find(x=>x.id===received.id&&x.state==='complete'));
 // Finalizing twice cannot duplicate a file or re-open a completed transfer.
 const again=await f.call(f.bob,f.bob.status().peers[0].id,'POST',`/peer/transfers/${received.id}/complete`);
 assert.equal(again.status,200,again.text);
 assert.equal(again.json().state,'complete');
 assert.equal(f.alice.status().transfers.filter(x=>x.id===received.id).length,1);
 // Reverse direction in the same session, then queue-row and history semantics.
 const other=path.join(f.dir,'second.txt');
 await fs.writeFile(other,Buffer.from('hello from alice'));
 await f.alice.send(f.bob.status().id,[other]);
 const back=await until('Alice → Bob completion',()=>f.bob.status().transfers.find(x=>x.direction==='receive'&&['complete','failed'].includes(x.state)));
 assert.equal(back.state,'complete',back.error??'');
 assert.deepEqual(await fs.readFile(path.join(f.bob.status().receiveDir,`${back.id}-second.txt`)),Buffer.from('hello from alice'));
 assert.equal(f.alice.status().history.filter(h=>h.state==='complete').length,2,'one sent + one received row');
 assert.equal(f.bob.status().history.filter(h=>h.state==='complete').length,2);
 await f.alice.remove(received.id);
 assert.deepEqual(await fs.readFile(saved),bytes,'removing a finished queue row never deletes the saved file');
});

test('a declined receive saves nothing and the sender is told instead of retrying silently',async t=>{
 const f=await fixture(t,{receive:r=>r.name!=='private.bin'});
 const source=path.join(f.dir,'private.bin');
 const bytes=Buffer.from('contents that must not land');
 await fs.writeFile(source,bytes);
 await f.bob.send(f.alice.status().id,[source]);
 const row=await until('decline to reach the sender',()=>f.bob.status().transfers.find(x=>['declined','failed','complete'].includes(x.state)));
 assert.equal(row.state,'declined',row.error??'');
 assert.match(row.error,/Declined on the receiving PC/);
 assert.deepEqual(await fs.readdir(path.join(f.alice.status().receiveDir,'.pending')),[],'a declined transfer never creates a partial');
 assert.equal(f.alice.status().transfers.find(x=>x.state==='declined'&&x.name==='private.bin')?.id,row.id,'the receiver remembers the decline');
 assert.equal(f.alice.status().history[0].state,'declined');
 // Re-offering the declined id is refused; a fresh id for a different file still works.
 const retry=await f.call(f.bob,f.bob.status().peers[0].id,'POST','/peer/transfers',{id:row.id,name:'private.bin',size:bytes.length,sha256:digest(bytes)});
 assert.equal(retry.status,403,retry.text);
 const ok=path.join(f.dir,'public.bin');
 await fs.writeFile(ok,Buffer.from('fine to share'));
 await f.bob.send(f.alice.status().id,[ok]);
 const landed=await until('the allowed file',()=>f.alice.status().transfers.find(x=>x.name==='public.bin'&&x.state==='complete'));
 assert.ok(landed);
});

test('unsigned, replayed, re-keyed, skewed and offset-smuggling requests never commit a byte',async t=>{
 const f=await fixture(t);
 const bytes=Buffer.concat([Buffer.from('A'.repeat(1024)),Buffer.from('B'.repeat(1024))]);
 const aliceId=f.alice.status().id,transfer=rid();
 const open=await f.call(f.bob,f.bob.status().peers[0].id,'POST','/peer/transfers',{id:transfer,name:'doc.bin',size:bytes.length,sha256:digest(bytes)});
 assert.equal(open.status,200,open.text);
 assert.equal(open.json().offset,0);
 // One committed chunk, then the byte-identical signed request replayed.
 const route=`/peer/transfers/${transfer}?offset=0`,chunk=bytes.subarray(0,1024);
 const header=signPeerRequest(f.bob.peers.get(aliceId).secret,{method:'PATCH',route,body:chunk,from:f.bob.identity.id,ts:Date.now(),nonce:rid()});
 const first=await f.call(f.bob,f.bob.status().peers[0].id,'PATCH',route,chunk,{header,headers:{'X-Chunk-Sha256':digest(chunk)}});
 assert.equal(first.status,200,first.text);
 assert.equal(first.json().offset,1024);
 const replay=await f.call(f.bob,f.bob.status().peers[0].id,'PATCH',route,chunk,{header,headers:{'X-Chunk-Sha256':digest(chunk)}});
 assert.equal(replay.status,403,replay.text);
 assert.match(replay.json().error,/Replayed/);
 assert.equal(f.alice.status().transfers.find(x=>x.id===transfer).offset,1024,'a replay must not commit bytes twice');
 // Other auth failures.
 assert.equal((await f.call(f.bob,f.bob.status().peers[0].id,'GET',`/peer/transfers/${rid()}`)).status,404,'an unknown transfer id is not enumerable');
 assert.equal((await f.call(f.bob,f.bob.status().peers[0].id,'GET','/peer/state',Buffer.alloc(0),{skipAuth:true})).status,401);
 assert.equal((await f.call(f.bob,f.bob.status().peers[0].id,'GET','/peer/state',Buffer.alloc(0),{secret:digest('other key')})).status,403);
 assert.equal((await f.call(f.bob,f.bob.status().peers[0].id,'GET','/peer/state',Buffer.alloc(0),{from:rid()})).status,401,'an unknown signer is not a peer');
 assert.equal((await f.call(f.bob,f.bob.status().peers[0].id,'GET','/peer/state',Buffer.alloc(0),{ts:Date.now()-11*60*1000})).status,403,'outside the clock window');
 const partial=path.join(f.alice.status().receiveDir,'.pending',`${transfer}.part`);
 const wrongHash=await f.call(f.bob,f.bob.status().peers[0].id,'PATCH',`/peer/transfers/${transfer}?offset=1024`,bytes.subarray(1024),{headers:{'X-Chunk-Sha256':digest('wrong')}});
 assert.equal(wrongHash.status,422,wrongHash.text);
 assert.equal((await fs.stat(partial)).size,1024,'a rejected chunk leaves nothing behind');
 assert.equal((await f.call(f.bob,f.bob.status().peers[0].id,'PATCH',`/peer/transfers/${transfer}?offset=999`,bytes.subarray(1024),{headers:{'X-Chunk-Sha256':digest(bytes.subarray(1024))}})).status,409,'a stale offset is refused');
 const overrun=await f.call(f.bob,f.bob.status().peers[0].id,'PATCH',`/peer/transfers/${transfer}?offset=1024`,Buffer.concat([bytes.subarray(1024),Buffer.from('extra')]));
 assert.equal(overrun.status,409,overrun.text);
 assert.equal((await fs.stat(partial)).size,1024);
 const good=await f.call(f.bob,f.bob.status().peers[0].id,'PATCH',`/peer/transfers/${transfer}?offset=1024`,bytes.subarray(1024),{headers:{'X-Chunk-Sha256':digest(bytes.subarray(1024))}});
 assert.equal(good.status,200,good.text);
 // A declared hash that does not match the committed bytes can never produce a completed file.
 const lie=rid();
 await f.call(f.bob,f.bob.status().peers[0].id,'POST','/peer/transfers',{id:lie,name:'lie.bin',size:3,sha256:digest('different')});
 await f.call(f.bob,f.bob.status().peers[0].id,'PATCH',`/peer/transfers/${lie}?offset=0`,Buffer.from('abc'),{headers:{'X-Chunk-Sha256':digest('abc')}});
 const lied=await f.call(f.bob,f.bob.status().peers[0].id,'POST',`/peer/transfers/${lie}/complete`);
 assert.equal(lied.status,422,lied.text);
 assert.equal(f.alice.status().transfers.find(x=>x.id===lie).offset,0,'a failed finalization resets the partial');
 await assert.rejects(()=>fs.stat(path.join(f.alice.status().receiveDir,'lie.bin')),'nothing is finalized on a hash mismatch');
 // The honest transfer still completes afterwards, byte-for-byte.
 const done=await f.call(f.bob,f.bob.status().peers[0].id,'POST',`/peer/transfers/${transfer}/complete`);
 assert.equal(done.status,200,done.text);
 assert.deepEqual(await fs.readFile(path.join(f.alice.status().receiveDir,`${transfer}-doc.bin`)),bytes);
 // Unpairing revokes the shared key; the received file stays.
 f.alice.unpair(f.alice.status().peers[0].id);
 assert.equal(f.alice.status().peers.length,0);
 const orphan=await f.call(f.bob,f.bob.status().peers[0].id,'GET','/peer/state',Buffer.alloc(0)).catch(e=>({status:0,text:String(e)}));
 assert.ok(orphan.status===401||orphan.status===0,JSON.stringify(orphan));
 assert.deepEqual(await fs.readFile(path.join(f.alice.status().receiveDir,`${transfer}-doc.bin`)),bytes);
});

test('receive-side manifests cannot smuggle paths, sizes, hashes or transfer ids',async t=>{
 const f=await fixture(t);
 const aliceId=f.alice.status().id;
 for(const bad of [{name:'../escape',size:1,sha256:digest('a')},{name:'a/b',size:1,sha256:digest('a')},{name:'a\\b',size:1,sha256:digest('a')},{name:'/abs',size:1,sha256:digest('a')},{name:'C:\\x',size:1,sha256:digest('a')},{name:'CON',size:1,sha256:digest('a')},{name:'nul.txt',size:1,sha256:digest('a')},{name:'trailing.',size:1,sha256:digest('a')},{name:'x'.repeat(121),size:1,sha256:digest('a')},{name:'big.bin',size:5*1024**3,sha256:digest('a')},{name:'x.bin',size:-1,sha256:digest('a')},{name:'x.bin',size:1.5,sha256:digest('a')},{name:'x.bin',size:1,sha256:'zz'},{name:'x.bin',size:1}]){
  const r=await f.call(f.bob,aliceId,'POST','/peer/transfers',{id:rid(),...bad});
  assert.equal(r.status,400,`${bad.name}: ${r.text}`);
 }
 for(const missing of [{name:'ok.bin',size:1,sha256:digest('a')},{id:'zz',name:'ok.bin',size:1,sha256:digest('a')},{id:rid().toUpperCase(),name:'ok.bin',size:1,sha256:digest('a')}]){
  assert.equal((await f.call(f.bob,aliceId,'POST','/peer/transfers',missing)).status,400,JSON.stringify(missing));
 }
 // An oversize chunk body is refused before it is buffered, and a huge manifest too.
 const oversize=await f.call(f.bob,aliceId,'PATCH',`/peer/transfers/${rid()}?offset=0`,Buffer.alloc(2*1024*1024)).catch(e=>({status:0,text:String(e)}));
 assert.ok(oversize.status===413||oversize.status===0||oversize.status===401,JSON.stringify(oversize));
 // An id can never be re-pointed at other content, and re-offering the identical manifest is a resume.
 const bytes=Buffer.from('first content'),transfer=rid(),second=rid();
 assert.equal((await f.call(f.bob,aliceId,'POST','/peer/transfers',{id:transfer,name:'notes.txt',size:bytes.length,sha256:digest(bytes)})).status,200);
 assert.equal((await f.call(f.bob,aliceId,'POST','/peer/transfers',{id:transfer,name:'notes.txt',size:bytes.length,sha256:digest('other content')})).status,409,'same id, different manifest');
 // Once a consent prompt has resolved, the next offer is accepted — a finished or declined row never wedges the channel.
 assert.equal((await f.call(f.bob,aliceId,'POST','/peer/transfers',{id:second,name:'second.txt',size:3,sha256:digest('abc')})).status,200);
 const resume=await f.call(f.bob,aliceId,'POST','/peer/transfers',{id:transfer,name:'notes.txt',size:bytes.length,sha256:digest(bytes)});
 assert.equal(resume.status,200);
 assert.equal(resume.json().id,transfer,'re-offering the identical manifest is a resume, not a duplicate');
 assert.equal((await f.call(f.bob,aliceId,'POST',`/peer/transfers/${second}/cancel`,Buffer.alloc(0),{from:rid()})).status,401,'a request never acts on another peer');
 await f.alice.cancel(transfer);
 await f.alice.cancel(second);
 assert.equal(f.alice.status().transfers.length,0);
 assert.deepEqual(await fs.readdir(path.join(f.alice.status().receiveDir,'.pending')),[]);
});

test('interrupted and cancelled transfers stay honest: resume offset, no silent completion, no orphan partial',async t=>{
 const f=await fixture(t);
 const big=path.join(f.dir,'interrupt.bin');
 await fs.writeFile(big,crypto.randomBytes(24*1024*1024));
 const sending=f.bob.send(f.alice.status().id,[big]);
 const started=await until('committed bytes',()=>f.alice.status().transfers.find(x=>x.direction==='receive'&&x.offset>0));
 assert.ok(started.offset<started.size,'the receiver must be observed mid-transfer');
 await f.bob.cancel(started.id);
 await until('receiver cleanup',()=>f.alice.status().transfers.some(x=>x.id===started.id)?undefined:true);
 assert.deepEqual(await fs.readdir(path.join(f.alice.status().receiveDir,'.pending')),[],'a cancelled partial is removed on both PCs');
 await sending.catch(()=>{});
 assert.equal(f.bob.status().transfers.some(x=>x.id===started.id),false,'a cancelled row leaves the sender queue');
 // Now stop the receiver mid-flight: the sender must fail loudly, never claim success.
 const sending2=f.bob.send(f.alice.status().id,[big]);
 const row=await until('a second partial',()=>f.alice.status().transfers.find(x=>x.direction==='receive'&&x.offset>0));
 await f.alice.stop();
 await sending2.catch(()=>{});
 assert.deepEqual(await fs.readdir(path.join(f.alice.status().receiveDir,'.pending')),[],'a stopped receiver keeps no partial');
 const failure=await until('sender failure',()=>f.bob.status().transfers.find(x=>x.id===row.id&&['failed','complete'].includes(x.state)));
 assert.equal(failure.state,'failed','an interrupted transfer is reported as failed, not complete');
 assert.match(failure.error,/unreachable|Offset|Not found|Cancelled|stopped|timed out|complete/i);
 // Cross-session resume is deliberately unavailable: a restart clears the queue.
 await f.bob.stop();await f.bob.start();
 assert.equal(f.bob.status().transfers.length,0);
 await assert.rejects(()=>f.bob.resume(row.id),/no longer queued/i);
});

test('device labels are display-only, self-pairing is refused and presence exposes no secrets',async t=>{
 const f=await fixture(t);
 assert.ok(f.alice.status().urls.every(u=>u.startsWith('https://127.0.0.1:')),'only https origins are advertised');
 assert.equal(f.alice.status().protocol,'aem-peer/1');
 await f.alice.setName('Evil\n\rPC\u0000 name');
 assert.equal(f.alice.status().name,'Evil PC name','control characters can never spoof a consent dialog');
 const reparsed=f.alice.parseInvite((await f.alice.newInvite()).invitation);
 assert.equal(reparsed.name,'Evil PC name');
 assert.ok(!/[\r\n]/.test(reparsed.name));
 await assert.rejects(()=>f.alice.pairWith('AEM1-'+Buffer.from(JSON.stringify({v:1,i:f.alice.status().id,h:'127.0.0.1',p:f.alice.status().port,f:f.alice.identity.fingerprint,t:'y'.repeat(40)})).toString('base64url')),/own invitation/i);
 const hello=await f.call(f.bob,{address:'127.0.0.1',port:f.alice.status().port},'GET','/peer/hello',Buffer.alloc(0),{skipAuth:true,insecure:true});
 assert.equal(hello.status,200);
 const j=hello.json();
 assert.equal(j.protocol,'aem-peer/1');
 assert.equal(j.port,f.alice.status().port);
 assert.ok(!('secret'in j)&&!('peers'in j)&&!('transfers'in j),'presence never leaks pairing state');
 // A browser-style cross-origin request cannot read anything either: no CORS grant is ever returned.
 assert.equal(hello.headers['access-control-allow-origin'],undefined);
 const probe=await f.bob.probe({address:'127.0.0.1',port:f.alice.status().port});
 assert.equal(probe.id,f.alice.status().id);
 assert.equal(probe.fingerprint,f.alice.identity.fingerprint);
 // The identity key/cert is written for this PC only, and survives a restart so pairing does not rot.
 const mode=(await fs.stat(path.join(f.dir,'alice','state','peer-identity.json'))).mode&0o777;
 assert.ok(mode===0o600||mode===0o400,`identity file mode must be private, got ${mode.toString(8)}`);
 await f.alice.stop();await f.alice.start();
 assert.equal(f.alice.status().peers.length,1,'a restarted PC keeps its pinned peers');
 assert.equal(f.bob.status().peers.length,1);
 await f.bob.send(f.alice.status().id,[path.join(f.dir,'alice','state','peers.json')]);
 const selfSent=await until('send after restart',()=>f.alice.status().transfers.find(x=>x.state==='complete'||x.state==='failed'));
 assert.equal(selfSent.state,'complete','an already-paired PC can send again after a restart, using the stored key');
});

test('two simultaneous offers cannot stack two consent prompts on the receiving PC',async t=>{
 let seen=0,release;
 const gate=new Promise(r=>{release=r;});
 const f=await fixture(t,{receive:async()=>{if(seen++===0)await gate;return true;}});
 const aliceId=f.alice.status().id;
 const body=n=>({id:rid(),name:n,size:3,sha256:digest('abc')});
 const pendingFirst=f.call(f.bob,aliceId,'POST','/peer/transfers',body('first.bin'));
 await sleep(150);
 const blocked=await f.call(f.bob,aliceId,'POST','/peer/transfers',body('second.bin'));
 assert.equal(blocked.status,409,blocked.text);
 assert.match(blocked.json().error,/waiting for approval/);
 assert.equal(f.alice.status().transfers.length,0,'a locked offer has not created a row yet');
 release();
 const first=await pendingFirst;
 assert.equal(first.status,200,first.text);
 // Once consent resolves the lock is gone: only one row exists, and the next offer is accepted.
 assert.equal(f.alice.status().transfers.filter(x=>x.direction==='receive'&&x.state==='pending').length,1);
 assert.equal((await f.call(f.bob,aliceId,'POST','/peer/transfers',{id:rid(),name:'third.bin',size:3,sha256:digest('abc')})).status,200);
 await f.alice.newInvite();
});

test('the desktop bridge exposes every PC-to-PC operation on its documented channel',async()=>{
 // Real preload module, stubbed Electron runtime: this catches a renamed or missing ipc channel that
 // typecheck alone cannot see. It is wiring evidence, not GUI evidence on a Windows desktop.
 const exposed={},calls=[];
 const Module=require('node:module');
 const original=Module._load;
 Module._load=function(request,...rest){
  if(request==='electron')return{
   contextBridge:{exposeInMainWorld:(key,value)=>{exposed[key]=value;}},
   ipcRenderer:{invoke:(channel,...args)=>{calls.push({channel,args});return Promise.resolve({ok:true});},on:()=>{},removeListener:()=>{}},
  };
  return original.call(this,request,...rest);
 };
 let preload;
 try{preload=require('../dist-electron/preload.js');}finally{Module._load=original;}
 const peer=exposed.aemDesktop.peer;
 assert.ok(peer,'preload must expose aemDesktop.peer');
 assert.deepEqual(Object.keys(peer).sort(),['cancel','clearHistory','invite','name','onEvent','pair','probe','remove','resume','send','showFolder','start','status','stop','unpair'].sort());
 const expected={status:'peer:status',start:'peer:start',stop:'peer:stop',invite:'peer:invite',name:'peer:name',pair:'peer:pair',unpair:'peer:unpair',send:'peer:send',resume:'peer:resume',cancel:'peer:cancel',remove:'peer:remove',clearHistory:'peer:clearHistory',probe:'peer:probe',showFolder:'peer:showFolder'};
 calls.length=0;
 for(const [method,channel] of Object.entries(expected)){
  assert.equal(typeof peer[method],`function`,`${method} must be callable`);
  await peer[method](method==='port'?7:'x');
 }
 assert.deepEqual(calls.map(c=>c.channel),Object.values(expected),'each bridge method must hit its documented channel once');
 // The renderer contract lists exactly these methods; a drift here breaks the Transfer screen silently.
 const contract=fss.readFileSync(path.resolve('src/services/transfer/contract.ts'),'utf8');
 const declared=[...contract.matchAll(/^  ([a-zA-Z]+)\(/gm)].map(m=>m[1]);
 const peerBlock=contract.slice(contract.indexOf('export interface PeerBridge'),contract.indexOf('export interface TransferBridge'));
 for(const method of [...peerBlock.matchAll(/\s([a-zA-Z]+)\(/g)].map(m=>m[1]))assert.ok(method in expected||method==='onEvent',`contract declares ${method} but the bridge does not`);
 assert.ok(declared.length>0);
 // Both companion channels stay distinct: the browser bridge must not have grown pairing operations.
 const transfer=exposed.aemDesktop.transfer;
 assert.deepEqual(Object.keys(transfer).sort(),['invitation','offer','remove','revoke','showFolder','start','status','stop'].sort());
 assert.ok(!('pair'in transfer)&&!('unpair'in transfer),'aem-lan/1 must not accept aem-peer/1 pairing calls');
 // Every registered channel exists on the main-process side too.
 const ipcSource=fss.readFileSync(path.resolve('dist-electron/ipc.js'),'utf8');
 for(const channel of new Set(Object.values(expected)))assert.ok(ipcSource.includes(`"${channel}"`)||ipcSource.includes(`'${channel}'`),`main process never handles ${channel}`);
 assert.ok(ipcSource.includes('aem:peerEvent'),'the main process must forward peer progress to the renderer');
});
