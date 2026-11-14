import fs from 'fs';
import path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import yazl from 'yazl';
const exec = promisify(execFile);
export interface PhoneDevice {serial:string;state:string;model:string}
export function parseDevices(text:string):PhoneDevice[]{
  return text.split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith('List ')&&!l.startsWith('*')).flatMap(l=>{
    const [serial,state,...detail]=l.trim().split(/\s+/);
    if(!serial||!state||serial.startsWith('emulator-'))return [];
    return [{serial,state,model:detail.find(x=>x.startsWith('model:'))?.slice(6).replace(/_/g,' ')||serial}];
  });
}
export function packageId(value:string):string {
  if(typeof value!=='string'||!/^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/.test(value))throw new Error('Invalid Android package identity');return value;
}
export function remoteFile(value:string):string {
  if(typeof value!=='string'||value.length>4096||!/^\/(sdcard|storage\/emulated\/0|data\/app)\/[A-Za-z0-9_./ ~+@=,()-]+$/.test(value)||value.split('/').includes('..'))throw new Error('Only accessible shared-storage files or installed package files may be read');return value;
}
const quote=(value:string)=>`'${remoteFile(value)}'`;
export async function hashFile(file:string):Promise<string>{const h=createHash('sha256');for await(const c of fs.createReadStream(file))h.update(c);return h.digest('hex');}
/** Uses Android's existing RSA/TLS authorization. Never enables insecure adb tcpip or bypasses device consent. */
export class PhoneManager {
  private session:ChildProcess|null=null;
  private sessionSerial:string|null=null;
  private error:string|null=null;
  private busy=false;
  private progress={phase:'idle',completed:0,total:0,message:''};
  constructor(private adb:string,private scrcpy:string|null,private downloads:string){}
  configure(adb:string,scrcpy:string|null){if(this.session||this.busy)throw new Error('Stop the phone session and transfer before changing tools');this.adb=adb;this.scrcpy=scrcpy;}
  private async command(args:string[],timeout=30000){
    if(!fs.existsSync(this.adb))throw new Error('ADB is not installed. Select the official scrcpy directory (with adb) or install Android platform-tools. No emulator is required.');
    const {stdout}=await exec(this.adb,args,{timeout,maxBuffer:8*1024**2,windowsHide:true});return stdout;
  }
  async devices(){return parseDevices(await this.command(['devices','-l']));}
  private async authorize(serial:string){
    const device=(await this.devices()).find(d=>d.serial===serial);
    if(!device||device.state!=='device')throw new Error(device?.state==='unauthorized'?'Unlock the phone and approve its USB debugging fingerprint.':'Phone is disconnected/offline. Reconnect and authorize it.');
  }
  status(){return {running:!!this.session,serial:this.sessionSerial,error:this.error,progress:this.progress,scrcpyAvailable:!!this.scrcpy&&fs.existsSync(this.scrcpy)};}
  async start(serial:string, pkg?:string){
    if(this.session)throw new Error('A phone display session is already active');
    await this.authorize(serial);
    if(!this.scrcpy||!fs.existsSync(this.scrcpy))throw new Error('Select a locally installed official scrcpy executable first');
    if(pkg){
      packageId(pkg);
      const result=await this.command(['-s',serial,'shell',`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`]);
      if(!/Events injected: 1/.test(result))throw new Error('The phone could not launch this package. Install it on the phone and check its launcher/permissions.');
    }
    const proc=spawn(this.scrcpy,['--serial',serial,'--max-size','1280','--max-fps','30','--no-audio','--window-title','AEM Store — Phone display'],{env:{...process.env,ADB:this.adb},windowsHide:true,stdio:['ignore','ignore','pipe']});
    this.session=proc;this.sessionSerial=serial;this.error=null;
    proc.stderr?.on('data',chunk=>{this.error=String(chunk).trim().slice(-2000);});
    proc.once('exit',(code)=>{this.session=null;this.sessionSerial=null;if(code===0)this.error=null;});
    await new Promise<void>((resolve,reject)=>{proc.once('spawn',()=>resolve());proc.once('error',e=>{this.session=null;this.sessionSerial=null;this.error=e.message;reject(e);});});
    return this.status(); // spawned, not a claim that a video frame has been rendered
  }
  stop(){this.session?.kill();return this.status();}
  async listApps(serial:string){await this.authorize(serial);const out=await this.command(['-s',serial,'shell','pm list packages -3']);return out.split(/\r?\n/).filter(l=>l.startsWith('package:')).map(l=>l.slice(8).trim()).filter(p=>/^[\w.]+$/.test(p));}
  private async remoteHash(serial:string,file:string){
    const out=await this.command(['-s',serial,'shell',`toybox sha256sum ${quote(file)}`],120000);
    const hash=out.match(/^([a-fA-F0-9]{64})\s/)?.[1]?.toLowerCase();
    if(!hash)throw new Error('Phone SHA-256 verification unavailable; transfer is not marked complete');return hash;
  }
  private async pullVerified(serial:string,remote:string,local:string){
    const before=await this.remoteHash(serial,remote);
    await this.command(['-s',serial,'pull',remote,local],10*60*1000);
    if(await hashFile(local)!==before||await this.remoteHash(serial,remote)!==before)throw new Error('Phone file changed or SHA-256 mismatch');
  }
  private async transfer<T>(message:string,fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error('A phone transfer is already in progress');this.busy=true;this.progress={phase:'transferring',completed:0,total:1,message};
    try{const result=await fn();this.progress={...this.progress,phase:'complete',completed:this.progress.total};return result;}
    catch(e:any){this.progress={...this.progress,phase:'failed',message:e.message};throw e;}finally{this.busy=false;}
  }
  async pull(serial:string,remote:string){return this.transfer('Receiving and verifying file',async()=>{
    await this.authorize(serial);remoteFile(remote);await fs.promises.mkdir(this.downloads,{recursive:true});
    const output=path.join(this.downloads,`${randomUUID()}-${path.basename(remote).replace(/[^\w.-]/g,'_')}`);
    try{await this.pullVerified(serial,remote,output+'.part');await fs.promises.rename(output+'.part',output);return {path:output,sha256:await hashFile(output)};}
    finally{await fs.promises.rm(output+'.part',{force:true});}
  });}
  async push(serial:string,local:string){return this.transfer('Sending and verifying file',async()=>{
    await this.authorize(serial);if(!fs.statSync(local).isFile())throw new Error('Select a regular file');
    const remote=`/sdcard/Download/AEM-Transfer/${randomUUID()}-${path.basename(local).replace(/[^\w.-]/g,'_')}`;
    const hash=await hashFile(local);await this.command(['-s',serial,'shell','mkdir -p /sdcard/Download/AEM-Transfer']);
    try{
      await this.command(['-s',serial,'push',local,remote+'.part'],10*60*1000);
      if(await this.remoteHash(serial,remote+'.part')!==hash)throw new Error('SHA-256 mismatch; file not published on phone');
      await this.command(['-s',serial,'shell',`mv ${quote(remote+'.part')} ${quote(remote)}`]);return {path:remote,sha256:hash};
    }finally{await this.command(['-s',serial,'shell',`rm -f ${quote(remote+'.part')}`]).catch(()=>{});}
  });}
  async exportPackage(serial:string,pkg:string){return this.transfer('Exporting installed base and split APKs',async()=>{
    await this.authorize(serial);packageId(pkg);
    const out=await this.command(['-s',serial,'shell',`pm path ${pkg}`]);
    const paths=out.split(/\r?\n/).filter(l=>l.startsWith('package:')).map(l=>remoteFile(l.slice(8).trim()));
    if(!paths.length||paths.length>512)throw new Error('Package components inaccessible or invalid count');
    await fs.promises.mkdir(this.downloads,{recursive:true});const dir=await fs.promises.mkdtemp(path.join(this.downloads,'.export-'));
    const output=path.join(this.downloads,`${pkg}-${randomUUID()}.apks`);
    try{
      this.progress.total=paths.length;
      const hashes:Record<string,string>={};
      for(let i=0;i<paths.length;i++){const local=path.join(dir,`component-${i}.apk`);await this.pullVerified(serial,paths[i],local);hashes[path.basename(local)]=await hashFile(local);this.progress.completed=i+1;}
      const after=await this.command(['-s',serial,'shell',`pm path ${pkg}`]);if(after!==out)throw new Error('Application updated during export; retry');
      const zip=new yazl.ZipFile();
      for(const name of Object.keys(hashes))zip.addFile(path.join(dir,name),name);
      zip.addBuffer(Buffer.from(JSON.stringify({packageIdentity:pkg,sha256:hashes,notice:'Package files only; no app data, ownership, DRM or account entitlements transferred.'},null,2)),'aem-package.json');
      const writing=pipeline(zip.outputStream,fs.createWriteStream(output+'.part',{flags:'wx'}));zip.end();await writing;
      await fs.promises.rename(output+'.part',output);return {path:output,sha256:await hashFile(output),components:paths.length};
    }finally{await fs.promises.rm(dir,{recursive:true,force:true});await fs.promises.rm(output+'.part',{force:true});}
  });}
}
