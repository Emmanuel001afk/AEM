/** Application-neutral LAN companion. HTTPS + one-use out-of-band invitation + explicit local consent.
 * Separate from Android Wi-Fi Direct protocol 6. Never accepts that protocol's unauthenticated tokens.
 * AEM-to-AEM desktop pairing lives in ./peer.ts and shares only the primitives in ./protocol.ts.
 */
import https from 'https';
import type {IncomingMessage,ServerResponse} from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {generate} from 'selfsigned';
import {Bonjour} from 'bonjour-service';
import {LAN_CHUNK as CHUNK,LAN_MAX_FILE as MAX_FILE,LAN_MAX_TOTAL as MAX_TOTAL,json,jsonBody,readBody as body,sha,equal,randomId as id,secret,hashFile,validateManifest,HttpError} from './protocol';
export {validateManifest};
export interface TransferConsent {kind:'pair'|'receive';name:string;address:string;size?:number;sha256?:string}
export interface TransferOptions {root:string;assets:string;consent:(request:TransferConsent)=>Promise<boolean>;advertise?:boolean;bindHost?:string;port?:number}
interface Peer {id:string;name:string;address:string;expiresAt:number}
interface FileEntry {id:string;name:string;size:number;sha256:string;offset:number;state:'pending'|'complete';owner:string;direction:'receive'|'send';file:string;busy?:boolean}
export class TransferService {
  private server:https.Server|null=null;
  private starting:Promise<ReturnType<TransferService["status"]>>|null=null;
  private advertisement:Bonjour|null=null;
  private invitation='';private inviteUntil=0;private inviteBusy=false;
  private peers=new Map<string,Peer>();
  private files=new Map<string,FileEntry>();
  private attempts=new Map<string,{count:number;until:number}>();
  private port=0;private addresses:string[]=[];private fingerprint='';private ca='';
  private origins=new Set<string>();private generation=0;private pending=new Set<string>();
  constructor(private options:TransferOptions){}
  get certificate(){return this.ca;}
  private publicFile(f:FileEntry){return {id:f.id,name:f.name,size:f.size,sha256:f.sha256,offset:f.offset,state:f.state,direction:f.direction};}
  status(){return {running:!!this.server,port:this.port,fingerprint:this.fingerprint,urls:this.addresses.map(a=>`https://${a}:${this.port}/`),invitation:this.invitation,inviteUntil:this.inviteUntil,peers:[...this.peers.values()],files:[...this.files.values()].map(f=>this.publicFile(f))};}
  async start(){
    if(this.starting)return this.starting;
    this.starting=this.startInternal();
    try{return await this.starting;}finally{this.starting=null;}
  }
  private async startInternal(){
    if(this.server)return this.status();
    this.generation++;
    fs.mkdirSync(this.options.root,{recursive:true});
    fs.mkdirSync(path.join(this.options.root,'.pending'),{recursive:true,mode:0o700});
    // Stopped/revoked sessions cannot resume. Remove only AEM's UUID-named partials.
    for(const name of fs.readdirSync(path.join(this.options.root,'.pending')))if(/^[a-f0-9]{32}\.part$/.test(name))fs.rmSync(path.join(this.options.root,'.pending',name),{force:true});
    this.addresses=[...new Set(Object.values(os.networkInterfaces()).flat().filter(a=>a?.family==='IPv4'&&!a.internal).map(a=>a!.address))];
    const hosts=[...this.addresses,'127.0.0.1'];
    const cert=await new Promise<{private:string;cert:string}>((resolve,reject)=>generate([{name:'commonName',value:'AEM Local Transfer'}],{keySize:2048,days:1,algorithm:'sha256',extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:hosts.map(ip=>({type:7,ip}))}]},(e,r)=>e?reject(e):resolve(r)));
    this.ca=cert.cert;this.fingerprint=new crypto.X509Certificate(cert.cert).fingerprint256;
    const server=https.createServer({key:cert.private,cert:cert.cert,minVersion:'TLSv1.2'},(req,res)=>{void this.route(req,res).catch(e=>{const status=e instanceof HttpError?e.status:500;if(!res.headersSent){res.setHeader('Connection','close');json(res,{error:e instanceof HttpError?e.message:'Transfer operation failed'},status);}else res.destroy();});});
    server.requestTimeout=30000;server.headersTimeout=15000;server.maxHeadersCount=30;server.maxConnections=32;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.options.port??0,this.options.bindHost??'0.0.0.0',()=>{server.removeListener('error',reject);resolve();});});
    server.on('error',()=>{void this.stop();});this.server=server;
    this.port=(server.address() as import('net').AddressInfo).port;
    this.origins=new Set(hosts.map(a=>`https://${a}:${this.port}`));this.newInvitation();
    if(this.options.advertise!==false){try{this.advertisement=new Bonjour(undefined,()=>{});this.advertisement.publish({name:`AEM Local Transfer ${id().slice(0,6)}`,type:'aem-transfer',port:this.port,txt:{protocol:'aem-lan/1',tls:'required'}});}catch{this.advertisement?.destroy();this.advertisement=null;}}
    return this.status();
  }
  newInvitation(){if(!this.server)throw new Error('Start transfer first');this.invitation=secret();this.inviteUntil=Date.now()+120000;return this.status();}
  async stop(){
    if(this.starting)await this.starting.catch(()=>{});
    this.generation++;this.invitation='';this.inviteUntil=0;this.peers.clear();this.pending.clear();this.attempts.clear();
    this.advertisement?.unpublishAll();this.advertisement?.destroy();this.advertisement=null;
    const server=this.server;this.server=null;
    if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
    for(const f of this.files.values())if(f.direction==='receive'&&f.state==='pending')await fs.promises.rm(f.file,{force:true}).catch(()=>{});
    this.files.clear();this.ca='';
  }
  async revoke(peerId:string){
    for(const [token,p] of this.peers)if(p.id===peerId)this.peers.delete(token);
    for(const [key,f] of this.files)if(f.owner===peerId){if(f.direction==='receive'&&f.state==='pending')await fs.promises.rm(f.file,{force:true}).catch(()=>{});this.files.delete(key);}
  }
  async offer(paths:string[]){
    if(!this.server)throw new Error('Start transfer first');
    if(!Array.isArray(paths)||paths.length>16||this.files.size+paths.length>64)throw new Error('Too many files');
    for(const file of paths){const stat=await fs.promises.stat(file);if(!stat.isFile())throw new Error('Select a regular file');const m=validateManifest({name:path.basename(file),size:stat.size,sha256:await hashFile(file)});const key=id();this.files.set(key,{...m,id:key,offset:0,state:'complete',direction:'send',owner:'shared',file});}
    return this.status();
  }
  async remove(fileId:string){const f=this.files.get(fileId);if(f?.busy)throw new Error('Pause the active transfer first');if(f?.direction==='receive'&&f.state==='pending')await fs.promises.rm(f.file,{force:true});this.files.delete(fileId);return this.status();}
  private authenticated(req:IncomingMessage){
    const token=String(req.headers.authorization||'').replace(/^Bearer /,'');const p=this.peers.get(sha(token));
    if(!p||p.expiresAt<Date.now())throw new HttpError(401,'Pairing expired or revoked');return p;
  }
  private async route(req:IncomingMessage,res:ServerResponse){
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const origin=`https://${req.headers.host}`;
    if(!this.origins.has(origin)||req.headers.origin&&req.headers.origin!==origin)throw new HttpError(403,'Foreign host/origin rejected');
    const url=new URL(req.url||'/',origin);
    if(req.method==='GET'&&['/','/client.js','/style.css'].includes(url.pathname)){
      const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
      res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');
      res.end(await fs.promises.readFile(path.join(this.options.assets,file)));return;
    }
    const address=req.socket.remoteAddress||'unknown';
    if(req.method==='POST'&&url.pathname==='/pair'){
      let a=this.attempts.get(address);if(!a||a.until<Date.now()){if(this.attempts.size>=128)this.attempts.clear();a={count:0,until:Date.now()+60000};this.attempts.set(address,a);}if(++a.count>6)throw new HttpError(429,'Pairing rate limit');
      const b=await jsonBody(req);
      if(this.inviteBusy||!this.invitation||Date.now()>this.inviteUntil||typeof b.invitation!=='string'||!equal(b.invitation,this.invitation))throw new HttpError(403,'Invalid or expired invitation');
      if(this.peers.size>=8)throw new HttpError(429,'Peer limit');
      const name=typeof b.name==='string'?b.name.trim():'';if(!name||name.length>80||/[\p{Cc}\p{Cf}]/u.test(name))throw new HttpError(400,'Invalid device label');
      this.inviteBusy=true;const generation=this.generation;const invitation=this.invitation;
      try{
        if(!await this.options.consent({kind:'pair',name,address}))throw new HttpError(403,'Pairing declined on PC');
        if(generation!==this.generation||invitation!==this.invitation||Date.now()>this.inviteUntil)throw new HttpError(403,'Invitation no longer active');
        this.invitation='';this.inviteUntil=0;const token=secret();const p={id:id(),name,address,expiresAt:Date.now()+3600000};this.peers.set(sha(token),p);json(res,{token,peer:p,protocol:'aem-lan/1',maxFileBytes:MAX_FILE,chunkBytes:CHUNK});
      }finally{this.inviteBusy=false;}return;
    }
    const peer=this.authenticated(req);
    if(req.method==='GET'&&url.pathname==='/api/state'){json(res,{peer,files:[...this.files.values()].filter(f=>f.owner===peer.id||f.direction==='send').map(f=>this.publicFile(f))});return;}
    if(req.method==='POST'&&url.pathname==='/api/uploads'){
      const m=validateManifest(await jsonBody(req));
      const existing=[...this.files.values()].find(f=>f.owner===peer.id&&f.name===m.name&&f.sha256===m.sha256&&f.size===m.size);
      if(existing){json(res,this.publicFile(existing));return;}
      if(this.pending.has(peer.id))throw new HttpError(409,'Another offer is pending approval');
      if(this.files.size>=64)throw new HttpError(429,'Transfer queue full');
      const generation=this.generation;this.pending.add(peer.id);
      try{
        if(!await this.options.consent({kind:'receive',name:m.name,address:peer.name,size:m.size,sha256:m.sha256}))throw new HttpError(403,'File declined on PC');
        this.authenticated(req);if(generation!==this.generation)throw new HttpError(403,'Receiver stopped');
        const disk=await fs.promises.statfs(this.options.root);
        const used=[...this.files.values()].filter(f=>f.direction==='receive').reduce((s,f)=>s+f.size,0);
        const reserved=[...this.files.values()].filter(f=>f.direction==='receive'&&f.state==='pending').reduce((s,f)=>s+f.size-f.offset,0);
        if(used+m.size>MAX_TOTAL||disk.bavail*disk.bsize<m.size+reserved+512*1024*1024)throw new HttpError(507,'Insufficient transfer quota or disk space');
        const key=id(),file=path.join(this.options.root,'.pending',`${key}.part`);
        const f:FileEntry={...m,id:key,file,owner:peer.id,direction:'receive',offset:0,state:'pending'};this.files.set(key,f);
        try{await fs.promises.writeFile(file,'',{flag:'wx',mode:0o600});json(res,this.publicFile(f));}catch(e){this.files.delete(key);throw e;}
      }finally{this.pending.delete(peer.id);}return;
    }
    const match=/^\/api\/(uploads|offers)\/([a-f0-9]{32})(\/complete)?$/.exec(url.pathname);
    if(!match)throw new HttpError(404,'Not found');
    const f=this.files.get(match[2]);if(!f||match[1]==='uploads'&&(f.direction!=='receive'||f.owner!==peer.id)||match[1]==='offers'&&f.direction!=='send')throw new HttpError(404,'Not found');
    if(match[1]==='offers'&&req.method==='GET'){
      const range=/^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range||''));if(!range)throw new HttpError(416,'Explicit bounded byte range required');
      const start=Number(range[1]),end=Number(range[2]);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=f.size||end-start>=CHUNK)throw new HttpError(416,'Invalid range');
      const st=await fs.promises.stat(f.file);if(st.size!==f.size)throw new HttpError(409,'Source file changed; re-offer it');
      res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${f.size}`,'Accept-Ranges':'bytes'});
      const stream=fs.createReadStream(f.file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
    }
    if(f.busy)throw new HttpError(409,'File already in use');f.busy=true;
    try{
      if(req.method==='PATCH'&&!match[3]){
        if(f.state==='complete')throw new HttpError(409,'Already complete');
        const offset=Number(url.searchParams.get('offset'));
        const chunk=await body(req,CHUNK);this.authenticated(req);
        if(this.files.get(f.id)!==f)throw new HttpError(403,'Transfer revoked');
        f.offset=(await fs.promises.stat(f.file)).size;
        if(!Number.isSafeInteger(offset)||offset!==f.offset||!chunk.length||f.offset+chunk.length>f.size)throw new HttpError(409,'Offset mismatch; refresh transfer state');
        if(typeof req.headers['x-chunk-sha256']!=='string'||!equal(sha(chunk),req.headers['x-chunk-sha256']))throw new HttpError(422,'Chunk checksum mismatch');
        const fd=await fs.promises.open(f.file,'r+');try{let n=0;while(n<chunk.length){const w=await fd.write(chunk,n,chunk.length-n,offset+n);if(!w.bytesWritten)throw new Error('Short write');n+=w.bytesWritten;}await fd.sync();}finally{await fd.close();}
        f.offset+=chunk.length;json(res,this.publicFile(f));return;
      }
      if(req.method==='POST'&&match[3]){
        if(f.state==='pending'){
          if(f.offset!==f.size)throw new HttpError(409,'File incomplete');
          if(await hashFile(f.file)!==f.sha256){await fs.promises.truncate(f.file,0);f.offset=0;throw new HttpError(422,'Final checksum mismatch; partial file reset');}
          this.authenticated(req);if(this.files.get(f.id)!==f)throw new HttpError(403,'Transfer revoked');
          const target=path.join(this.options.root,`${f.id}-${f.name}`);await fs.promises.rename(f.file,target);f.file=target;f.state='complete';
        }
        json(res,this.publicFile(f));return;
      }
      throw new HttpError(405,'Unsupported operation');
    }finally{f.busy=false;}
  }
}
