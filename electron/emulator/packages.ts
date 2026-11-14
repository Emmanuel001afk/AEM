import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import yauzl from 'yauzl';
import { sdkCommand } from './tool-process';
const exec = promisify(execFile);
export const PACKAGE_LIMITS = {entries:512, bytes:4*1024**3, fileBytes:2*1024**3, ratio:250};
export function validateArchiveEntry(name: string, size: number, compressed: number, mode: number) {
  if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(x=>x==='..'||x==='.'||/[. ]$/.test(x))) throw new Error('Unsafe package archive path');
  if ((mode & 0xf000) === 0xa000) throw new Error('Symlinks are not allowed in packages');
  if (!Number.isSafeInteger(size) || size<0 || size>PACKAGE_LIMITS.fileBytes || size>Math.max(1,compressed)*PACKAGE_LIMITS.ratio) throw new Error('Archive expansion limit exceeded');
}
/** Extract APKs only, into generated names. No archive pathname becomes a filesystem destination. */
export async function extractPackage(file: string, destination: string): Promise<string[]> {
  const zip = await new Promise<yauzl.ZipFile>((resolve,reject)=>yauzl.open(file,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(e,z)=>e?reject(e):resolve(z!)));
  const files: string[]=[]; let entries=0, total=0; const names=new Set<string>();
  return new Promise((resolve,reject)=>{
    let failed=false;
    const fail=(e:unknown)=>{if(!failed){failed=true;zip.close();reject(e);}};
    zip.on('error',fail);
    zip.on('end',()=> files.length ? resolve(files) : fail(new Error('No APK components in archive')));
    zip.on('entry',async (entry:yauzl.Entry)=>{
      try {
        if (++entries>PACKAGE_LIMITS.entries || (total+=entry.uncompressedSize)>PACKAGE_LIMITS.bytes) throw new Error('Package archive exceeds count/size limits');
        validateArchiveEntry(entry.fileName,entry.uncompressedSize,entry.compressedSize,entry.externalFileAttributes>>>16);
        const key=entry.fileName.toLowerCase();
        if(names.has(key)) throw new Error('Duplicate archive entry'); names.add(key);
        if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted package archive unsupported');
        if (/\.obb$/i.test(entry.fileName)) throw new Error('XAPK contains OBB assets: automatic asset placement is not supported. Use the authorized phone or publisher installer.');
        if (/\.apk$/i.test(entry.fileName)) {
          const stream=await new Promise<NodeJS.ReadableStream>((res,rej)=>zip.openReadStream(entry,(e,s)=>e?rej(e):res(s!)));
          const out=path.join(destination,`component-${files.length}.apk`);
          let actual=0;
          const bound=new Transform({transform(chunk,_enc,cb){actual+=chunk.length;cb(actual>entry.uncompressedSize?new Error('Decompressed size mismatch'):null,chunk);}});
          await pipeline(stream,bound,fs.createWriteStream(out,{flags:'wx'}));
          if(actual!==entry.uncompressedSize) throw new Error('Truncated archive component');
          files.push(out);
        }
        if(!failed)zip.readEntry();
      } catch(e){fail(e);}
    });
    zip.readEntry();
  });
}
export interface PackageMetadata {
  file: string; packageName: string; versionCode: number; versionName: string;
  minSdk: number; targetSdk?: number; split?: string; abis: string[]; certificate: string;
}
export function parseBadging(text:string): Omit<PackageMetadata,'file'|'certificate'> {
  const line=text.split('\n').find(x=>x.startsWith('package:'))||'';
  const packageName=line.match(/name='([^']+)'/)?.[1];
  const versionCode=Number(line.match(/versionCode='(\d+)'/)?.[1]);
  if(!packageName || !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(packageName)||!Number.isSafeInteger(versionCode)) throw new Error('Invalid Android package identity/version');
  return {packageName,versionCode,versionName:line.match(/versionName='([^']*)'/)?.[1]||'',split:line.match(/split='([^']+)'/)?.[1],minSdk:Number(text.match(/sdkVersion:'(\d+)'/)?.[1]||1),targetSdk:Number(text.match(/targetSdkVersion:'(\d+)'/)?.[1])||undefined,abis:[...(text.match(/^native-code: (.+)$/m)?.[1]||'').matchAll(/'([^']+)'/g)].map(x=>x[1])};
}
export function selectPackageSet(parts:PackageMetadata[], target:{api:number;abis:string[]}):PackageMetadata[] {
  if(!parts.length) throw new Error('Empty package set');
  const bases=parts.filter(p=>!p.split);
  if(bases.length!==1) throw new Error('Expected exactly one base APK. This archive may contain alternative APK sets; export a device-specific set with bundletool or from the phone.');
  const base=bases[0], splits=new Set<string>();
  for(const p of parts){
    if(p.packageName!==base.packageName||p.versionCode!==base.versionCode||p.certificate!==base.certificate) throw new Error('Components have different package, version or signing identity');
    if(splits.has(p.split||'')) throw new Error('Duplicate split identity'); splits.add(p.split||'');
    if(p.minSdk>target.api) throw new Error(`${p.packageName} requires Android API ${p.minSdk}; target is ${target.api}`);
  }
  const abiName=(p:PackageMetadata)=>['arm64-v8a','armeabi-v7a','x86_64','x86'].find(abi=>p.split===`config.${abi.replace(/-/g,'_')}`);
  const selected=parts.filter(p=>!abiName(p)||target.abis.includes(abiName(p)!));
  const native=selected.flatMap(p=>p.abis);
  if(native.length && !native.some(abi=>target.abis.includes(abi))) throw new Error(`Native libraries ${[...new Set(native)].join(', ')} do not support ${target.abis.join(', ')}`);
  if(parts.some(abiName)&&!selected.some(abiName)) throw new Error('No compatible ABI split; use phone execution or obtain a publisher-supported build');
  return selected;
}
export function findBuildTool(root:string, name:string):string {
  const dir=path.join(root,'build-tools');
  const available=fs.existsSync(dir)?fs.readdirSync(dir).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})):[];
  // Prefer the build-tools revision installed and validated by AEM over unrelated host tools.
  const versions=available.includes('34.0.0')?['34.0.0',...available.filter(v=>v!=='34.0.0')]:available;
  const ext=process.platform==='win32'?(name==='apksigner'?'.bat':'.exe'):'';
  for(const v of versions){const file=path.join(dir,v,name+ext);if(fs.existsSync(file))return file;}
  throw new Error(`Android SDK ${name} is missing. Install build-tools before package inspection.`);
}
export async function inspectApk(file:string, root:string):Promise<PackageMetadata> {
  const {stdout}=await exec(findBuildTool(root,'aapt'),['dump','badging',file],{timeout:20000,maxBuffer:4*1024**2,windowsHide:true});
  const cmd=sdkCommand(findBuildTool(root,'apksigner'),['verify','--print-certs',file]);
  const signature=await exec(cmd.file,cmd.args,{timeout:30000,maxBuffer:1024**2,windowsHide:true});
  const certificates=parseSignerCertificates(signature.stdout+'\n'+signature.stderr);
  if(!certificates.length) throw new Error(`APK signer certificate output was not recognized from ${cmd.file}: ${(signature.stdout+'\n'+signature.stderr).slice(-2500)}`);
  return {...parseBadging(stdout),file,certificate:certificates.join(',')};
}

/** A verified APK signature and a catalog certificate are distinct checks. */
export function assertCatalogCertificate(actual:string,expected:unknown):void {
  if(expected===undefined||expected===null||expected==='')return;
  if(typeof expected!=='string')throw new Error('Invalid catalog signing certificate');
  const normalized=expected.replace(/:/g,'').toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(normalized)||!actual.split(',').includes(normalized))throw new Error('Catalog signing certificate mismatch');
}

export function parseSignerCertificates(output:string):string[] {
  return [...new Set([...output.matchAll(/^Signer #\d+ certificate SHA-?256 digest:\s*([a-f0-9]{64})\s*$/gmi)].map(m=>m[1].toLowerCase()))].sort();
}
