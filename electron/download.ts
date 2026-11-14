import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
/** HTTPS-only, bounded streaming, atomic publish. Hash is required by catalog delivery, optional for user-selected downloads. */
export async function downloadVerified(url:string, destination:string, expectedSha256?:string, maxBytes=4*1024**3):Promise<string> {
  if(expectedSha256&&!/^[a-f0-9]{64}$/i.test(expectedSha256))throw new Error('Invalid expected SHA-256');
  let next=new URL(url); let response:Response|undefined;
  for(let redirects=0;redirects<=5;redirects++){
    if(next.protocol!=='https:'||next.username||next.password)throw new Error('Package download requires HTTPS without embedded credentials');
    response=await fetch(next,{redirect:'manual',signal:AbortSignal.timeout(15*60*1000)});
    if([301,302,303,307,308].includes(response.status)){
      await response.body?.cancel();
      const location=response.headers.get('location');if(!location)throw new Error('Redirect has no destination');next=new URL(location,next);response=undefined;continue;
    }
    break;
  }
  if(!response?.ok||!response.body)throw new Error(`Download failed: HTTP ${response?.status??'redirect limit'}`);
  const length=Number(response.headers.get('content-length'));
  if(length>maxBytes){await response.body.cancel();throw new Error('Package exceeds download size limit');}
  await fs.promises.mkdir(path.dirname(destination),{recursive:true});
  const partial=destination+'.'+randomUUID()+'.part'; const file=await fs.promises.open(partial,'wx');
  let bytes=0; const hash=createHash('sha256');
  try {
    for await(const chunk of response.body as any){bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Package exceeds download size limit');hash.update(chunk);await file.writeFile(chunk);}
    if(bytes===0)throw new Error('Empty download');
    const digest=hash.digest('hex');
    if(expectedSha256&&digest!==expectedSha256.toLowerCase())throw new Error('Downloaded SHA-256 mismatch; no installation attempted');
    await file.sync();await file.close();await fs.promises.rename(partial,destination);return digest;
  }catch(e){await file.close().catch(()=>{});await fs.promises.rm(partial,{force:true});throw e;}
}
