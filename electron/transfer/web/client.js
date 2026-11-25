import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
const $=id=>document.getElementById(id),CHUNK=1024*1024,MAX=256*1024*1024;
let token=sessionStorage.getItem('aem-lan-token')||'',active=null;
const downloads=new Map();
const say=s=>{$('status').textContent=s;};
const error=e=>say(e.name==='AbortError'?'Paused. Retry the same file to resume.':e.message);
// Never send invitation tokens in the URL, referrer, log or third-party request.
if(location.hash){$('invite').value=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname);}
async function request(url,options={}){
  const res=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers},signal:options.signal||active?.signal});
  if(!res.ok){const b=await res.json().catch(()=>({}));throw Error(b.error||`Transfer HTTP ${res.status}`);}return res;
}
const api=async(url,data)=> (await request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})).json();
async function fileHash(file){const h=sha256.create();for(let n=0;n<file.size;n+=CHUNK){if(active?.signal.aborted)throw new DOMException('Paused','AbortError');h.update(new Uint8Array(await file.slice(n,n+CHUNK).arrayBuffer()));}return bytesToHex(h.digest());}
function start(){if(active)throw Error('Pause or finish the current transfer first.');active=new AbortController();}
$('pair').onsubmit=async e=>{e.preventDefault();try{const r=await api('/pair',{invitation:$('invite').value.trim(),name:$('name').value.trim()});token=r.token;sessionStorage.setItem('aem-lan-token',token);$('invite').value='';say('Paired. PC permission granted for one hour.');await refresh();}catch(e){error(e);}};
$('forget').onclick=()=>{active?.abort();token='';sessionStorage.removeItem('aem-lan-token');downloads.clear();$('files').querySelectorAll('a[href^="blob:"]').forEach(a=>URL.revokeObjectURL(a.href));$('files').replaceChildren();say('Local pairing forgotten. Use Revoke on the PC to invalidate its grant immediately.');};
$('pause').onclick=()=>active?.abort();
$('send').onclick=async()=>{
  if(active){say('A transfer is already active.');return;}
  try{
    const file=$('upload').files[0];if(!file)throw Error('Choose a file first.');if(file.size>MAX)throw Error('Maximum size is 256 MiB.');start();say('Hashing file, then waiting for PC approval…');
    const digest=await fileHash(file);let state=await api('/api/uploads',{name:file.name,size:file.size,sha256:digest});
    while(state.offset<file.size){const bytes=new Uint8Array(await file.slice(state.offset,state.offset+CHUNK).arrayBuffer());state=await (await request(`/api/uploads/${state.id}?offset=${state.offset}`,{method:'PATCH',headers:{'Content-Type':'application/octet-stream','X-Chunk-Sha256':bytesToHex(sha256(bytes))},body:bytes})).json();$('progress').value=file.size?100*state.offset/file.size:100;say(`Sent ${state.offset} / ${file.size} bytes`);}
    await api(`/api/uploads/${state.id}/complete`,{});$('progress').value=100;say(`PC verified full SHA-256: ${digest}. Saved ${file.name}.`);
  }catch(e){error(e);}finally{active=null;}
};
async function download(f,button,article){
  if(active){say('A transfer is already active.');return;}
  try{
    if(f.size>MAX)throw Error('File exceeds browser limit');start();
    let d=downloads.get(f.id);if(!d){downloads.clear();d={offset:0,chunks:[],hash:sha256.create()};downloads.set(f.id,d);}
    while(d.offset<f.size){const end=Math.min(f.size-1,d.offset+CHUNK-1);const res=await request(`/api/offers/${f.id}`,{headers:{Range:`bytes=${d.offset}-${end}`}});if(res.status!==206||res.headers.get('content-range')!==`bytes ${d.offset}-${end}/${f.size}`)throw Error('Invalid range response');const chunk=new Uint8Array(await res.arrayBuffer());if(chunk.length!==end-d.offset+1)throw Error('Short download; retry to resume');d.chunks.push(chunk);d.hash.update(chunk);d.offset+=chunk.length;$('progress').value=100*d.offset/f.size;say(`Received ${d.offset} / ${f.size} bytes`);}
    const digest=bytesToHex(d.hash.digest());if(digest!==f.sha256){downloads.delete(f.id);throw Error('SHA-256 mismatch. Nothing saved; request a fresh PC offer.');}
    const blob=new Blob(d.chunks);d.chunks.length=0;const url=URL.createObjectURL(blob);downloads.delete(f.id);article.querySelectorAll('a[href^="blob:"]').forEach(old=>{URL.revokeObjectURL(old.href);old.remove();});const a=document.createElement('a');a.href=url;a.download=f.name;a.textContent=`SAVE VERIFIED ${f.name}`;a.onclick=()=>{setTimeout(()=>URL.revokeObjectURL(url),60000);};article.append(a);button.disabled=true;say(`SHA-256 verified: ${digest}. Tap Save to keep the file.`);$('progress').value=100;
  }catch(e){error(e);}finally{active=null;}
}
async function refresh(){const s=await (await request('/api/state')).json();$('files').querySelectorAll('a[href^="blob:"]').forEach(a=>URL.revokeObjectURL(a.href));$('files').replaceChildren();for(const f of s.files.filter(f=>f.direction==='send')){const a=document.createElement('article'),title=document.createElement('strong'),p=document.createElement('p'),button=document.createElement('button');title.textContent=f.name;p.textContent=`${f.size} bytes · SHA-256 ${f.sha256}`;button.textContent='RECEIVE / RESUME';button.onclick=()=>download(f,button,a);a.append(title,p,button);$('files').append(a);}if(!s.files.some(f=>f.direction==='send'))$('files').textContent='No files shared by PC yet.';}
$('refresh').onclick=()=>refresh().catch(error);
if(token){say('Existing pairing found. Refresh to check validity.');refresh().catch(error);}
