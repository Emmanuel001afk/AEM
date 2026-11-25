import {useEffect,useState} from 'react';
import {getDesktop} from '../services/emulator/contract';
export default function DevicesView(){
  const desktop=getDesktop();
  const [devices,setDevices]=useState<{serial:string;state:string;model:string}[]>([]);
  const [serial,setSerial]=useState(''),[apps,setApps]=useState<string[]>([]),[pkg,setPkg]=useState('');
  const [remote,setRemote]=useState('/sdcard/Download/'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [status,setStatus]=useState<any>(null);
  const [received,setReceived]=useState('');
  const [update,setUpdate]=useState<any>(null);
  useEffect(()=>{if(!desktop)return;let active=true;const poll=()=>desktop.phone.status().then(s=>{if(active)setStatus(s);}).catch(()=>{});void poll();const timer=setInterval(poll,1500);return()=>{active=false;clearInterval(timer);};},[desktop]);
  if(!desktop)return null;
  const act=async(fn:()=>Promise<unknown>)=>{setBusy(true);setMessage('Working…');try{const result=await fn();setMessage(result===null?'Cancelled':typeof result==='string'?result:'Operation finished.');}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const refresh=async()=>{const list=await desktop.phone.devices();setDevices(list);setSerial(s=>list.some(d=>d.serial===s)?s:list.find(d=>d.state==='device')?.serial||'');return `${list.length} phone(s) discovered. Authorization is controlled by Android.`;};
  const connected=devices.some(d=>d.serial===serial&&d.state==='device');
  const saveResult=(r:{path:string;sha256:string}|null)=>{if(!r)return null;setReceived(r.path);return `Verified SHA-256 ${r.sha256}. Saved: ${r.path}`;};
  return <section className="content">
    <div className="section-head"><div><span>CONNECTED AEM</span><h2>Devices & delivery</h2></div><button className="choice" disabled={busy} onClick={()=>act(refresh)}>DISCOVER AUTHORIZED PHONES</button></div>
    <p role="status" aria-live="polite">{message}</p>
    <div className="setting open"><div className="setting-body"><h3>Phone-powered desktop</h3>
      <p>The application stays on your phone. AEM coordinates a local scrcpy display and keyboard/mouse session; no emulator or commercial service is involved.</p>
      <p>Connect by USB, enable Developer options → USB debugging, unlock the phone and approve its RSA fingerprint. Already TLS-paired Android wireless-debugging devices also appear through ADB. AEM never enables unauthenticated TCP debugging.</p>
      <div className="choice-row"><button className="choice" disabled={busy} onClick={()=>act(()=>desktop.phone.configure())}>CHOOSE TRUSTED SCRCPY TOOLS</button><button className="choice" onClick={()=>desktop.openExternal('https://github.com/Genymobile/scrcpy/releases')}>OFFICIAL SCRCPY DOWNLOADS</button></div>
      <label>Phone <select value={serial} onChange={e=>{setSerial(e.target.value);setApps([]);setPkg('');}}><option value="">Choose a device</option>{devices.map(d=><option key={d.serial} value={d.serial} disabled={d.state!=='device'}>{d.model} · {d.state} · {d.serial}</option>)}</select></label>
      {devices.some(d=>d.state==='unauthorized')&&<p>Unauthorized phone detected. Approve the computer on the unlocked phone, then discover again.</p>}
      <div className="choice-row"><button className="choice" disabled={busy||!connected} onClick={()=>act(async()=>{setApps(await desktop.phone.apps(serial));return 'Installed third-party package list refreshed.';})}>LIST PHONE APPLICATIONS</button></div>
      <label>Application <select value={pkg} onChange={e=>setPkg(e.target.value)}><option value="">Show phone screen without launching an app</option>{apps.map(p=><option key={p} value={p}>{p}</option>)}</select></label>
      <div className="choice-row"><button className="install" disabled={busy||!connected||!status?.scrcpyAvailable||status.running} onClick={()=>act(()=>desktop.phone.start(serial,pkg||undefined))}>START PHONE DISPLAY</button><button className="choice" disabled={!status?.running} onClick={()=>act(()=>desktop.phone.stop())}>STOP DISPLAY</button></div>
      <p>{status?.running?'Phone display process active. Verify the video window on your desktop.':'No active phone display.'} {status?.error}</p>
      <p className="fine">Not OEM desktop mode. Samsung DeX, Motorola Ready For and USB-C video depend on the device/vendor and cable. AEM does not force unsupported display modes. Protected/DRM screens may be black; clipboard, audio and vendor input support vary. Revoke debugging authorizations in Android when finished.</p>
    </div></div>
    <div className="setting open"><div className="setting-body"><h3>Verified phone ↔ PC transfer</h3>
      <p>This direct route uses your Android-authorized ADB connection. Files are SHA-256 checked on both ends. Your existing Android Wi-Fi Direct phone-to-phone transfer is unchanged. For consented HTTPS browser pairing, chunked progress and resumable uploads, open the Transfer tab. That generic LAN companion is separate from Android Wi-Fi Direct.</p>
      <div className="choice-row"><button className="install" disabled={busy||!connected} onClick={()=>act(async()=>{const r=await desktop.phone.send(serial);return r?`Verified ${r.sha256}. Phone file: ${r.path}`:null;})}>SEND FILE TO PHONE</button><button className="choice" disabled={busy||!connected||!pkg} onClick={()=>act(async()=>saveResult(await desktop.phone.exportPackage(serial,pkg)))}>EXPORT APP + ALL ACCESSIBLE SPLITS</button></div>
      <label>Phone file path <input value={remote} onChange={e=>setRemote(e.target.value)} placeholder="/sdcard/Download/example.apks"/></label>
      <button className="choice" disabled={busy||!connected} onClick={()=>act(async()=>saveResult(await desktop.phone.receive(serial,remote)))}>RECEIVE FILE FROM PHONE</button>
      {status&&<p aria-live="polite">{status.progress.phase} · {status.progress.completed}/{status.progress.total} items · {status.progress.message}</p>}
      {received&&<button className="choice" onClick={()=>desktop.showItemInFolder(received)}>SHOW RECEIVED FILE</button>}
      <p className="fine">Packages only: no account data, Play ownership, licences or DRM transfer. Interrupted ADB copies must be retried; they are not reported as completed. Installing a received package on Android still uses its system installer and permissions.</p>
    </div></div>
    <div className="setting open"><div className="setting-body"><h3>AEM Store desktop updates</h3>
      <button className="choice" disabled={busy} onClick={()=>act(async()=>{const r=await desktop.checkForUpdates();setUpdate(r);return r.error||r.available? (r.error||`New AEM Store release ${r.latest}`) : 'No newer stable desktop release is available.';})}>CHECK STABLE RELEASE</button>
      {update&&<p>Installed: {update.current||'unknown'} · latest: {update.latest||'no published release'}</p>}
      {update?.available&&update.url&&<button className="install" onClick={()=>desktop.openExternal(update.url!)}>OPEN GITHUB RELEASE DOWNLOAD PAGE</button>}
      <p className="fine">Download the Setup EXE and compare its SHA-256 with the release checksums before upgrading. No downgrade or unattended installer is triggered. Native app details can compare the exact Windows uninstall registration with the catalog version; refresh after installing. Publisher registration identities must be accurate.</p>
    </div></div>
    <div className="setting open"><div className="setting-body"><h3>Build a genuine Windows variant</h3><p>For developers with licensed, adapted WinForms/WPF source, AEM invokes your local .NET SDK and NSIS to build a Windows application and Setup EXE. An APK or a source URL alone is insufficient. The recipe preserves the family relationship, separate package identities, source revision and licence.</p><button className="choice" disabled={busy||desktop.platform!=='win32'} onClick={()=>act(async()=>{const r=await desktop.native.build();if(r){await desktop.showItemInFolder(r.path);return `Built ${r.path}. Installation and launch still require verification.`;}return null;})}>BUILD ADAPTED WINDOWS SOURCE</button><p className="fine">Requires a schema-1 aem-native recipe (see docs/native-delivery.md), .NET SDK, trusted source, an application icon and local NSIS. AEM cannot port proprietary Android-only code without access to the necessary source/components.</p></div></div>
  </section>;
}
