// Real Chromium companion + real HTTPS service; consent is auto-approved ONLY by this test fixture.
const {app,BrowserWindow,session}=require('electron');
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const assert=require('assert/strict');
const {TransferService}=require('../dist-electron/transfer/service.js');
let service,win;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(expression){for(let i=0;i<100;i++){const r=await win.webContents.executeJavaScript(expression);if(r)return r;await wait(100);}throw new Error('Browser condition timed out: '+expression+' status='+await win.webContents.executeJavaScript('document.getElementById("status").textContent'));}
app.whenReady().then(async()=>{
 const root=fs.mkdtempSync(path.join(app.getPath('temp'),'aem-lan-browser-'));
 try{
  service=new TransferService({root,assets:path.resolve('dist-electron/transfer/web'),advertise:false,bindHost:'127.0.0.1',consent:async()=>true});
  const status=await service.start();const partition=session.fromPartition('aem-lan-test-'+Date.now());
  partition.setCertificateVerifyProc((request,callback)=>{
   // Trust exactly this test's generated leaf certificate, not arbitrary TLS errors.
   let matches=false;try{matches=request.hostname==='127.0.0.1'&&new crypto.X509Certificate(request.certificate.data).fingerprint256===status.fingerprint;}catch{}
   callback(matches?0:-2);
  });
  win=new BrowserWindow({show:false,webPreferences:{session:partition,nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await win.loadURL(`https://127.0.0.1:${status.port}/`);
  await win.webContents.executeJavaScript(`document.getElementById('name').value='Independent browser client';document.getElementById('invite').value=${JSON.stringify(status.invitation)};document.getElementById('pair').requestSubmit();`);
  await until(`document.getElementById('status').textContent.includes('Paired.')`);
  await win.webContents.executeJavaScript(`(()=>{const d=new DataTransfer();d.items.add(new File([new Uint8Array(1234567).fill(71)],'browser-upload.bin'));document.getElementById('upload').files=d.files;document.getElementById('send').click();})()`);
  await until(`document.getElementById('status').textContent.includes('PC verified full SHA-256')`);
  const expected=Buffer.alloc(1234567,71);const received=service.status().files.find(f=>f.direction==='receive');assert.equal(received.state,'complete');assert.deepEqual(fs.readFileSync(path.join(root,received.id+'-browser-upload.bin')),expected);
  const source=path.join(root,'pc-source.bin');const bytes=crypto.randomBytes(54321);fs.writeFileSync(source,bytes);await service.offer([source]);
  await win.webContents.executeJavaScript(`document.getElementById('refresh').click()`);
  await until(`document.querySelector('#files button')!==null`);
  await win.webContents.executeJavaScript(`document.querySelector('#files button').click()`);
  await until(`document.querySelector('#files a')!==null`);
  const hash=await win.webContents.executeJavaScript(`(async()=>{const b=await (await fetch(document.querySelector('#files a').href)).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).map(x=>x.toString(16).padStart(2,'0')).join('');})()`);
  assert.equal(hash,crypto.createHash('sha256').update(bytes).digest('hex'));
  console.log('::notice title=LAN browser runtime::Real Chromium paired over certificate-pinned HTTPS, uploaded a multi-chunk file to PC, and downloaded/verified a PC file before exposing Save. No platform-name allowlist. Consent auto-approval exists only in this test fixture; physical mobile/browser/firewall tests remain separate.');
  win.destroy();await service.stop();fs.rmSync(root,{recursive:true,force:true});app.exit(0);
 }catch(e){fs.writeFileSync('aem-lan-browser-failure.txt',String(e));console.error(e);win?.destroy();if(service)await service.stop().catch(()=>{});app.exit(1);}
}).catch(e=>{fs.writeFileSync('aem-lan-browser-failure.txt',String(e));app.exit(1);});
