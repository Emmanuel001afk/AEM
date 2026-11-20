import {useEffect,useState} from 'react';
import PeerTransfer from './PeerTransfer';
import {getDesktop} from '../../services/emulator/contract';
import type {LanStatus} from '../../services/transfer/contract';
/** Browser companion panel (`aem-lan/1`): one generic local companion, no publisher/platform-name allowlist. */
function LanCompanion(){
  const bridge=getDesktop()?.transfer;
  const [state,setState]=useState<LanStatus|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let live=true;const poll=()=>bridge?.status().then(s=>{if(live)setState(s);}).catch(()=>{});void poll();const timer=setInterval(poll,1500);return()=>{live=false;clearInterval(timer);};},[bridge]);
  const act=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();if(bridge)setState(await bridge.status());setMessage('Request finished. Only SHA-256 verified files are marked complete.');}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  if(!bridge)return null;
  return <section className="content"><div className="section-head"><div><span>ANY DEVICE · LOCAL ONLY</span><h2>Phone ↔ PC transfer</h2></div></div>
    <p>Use a compatible browser on any phone, tablet or computer. Files stay on your local network. Android Wi-Fi Direct phone-to-phone transfer and authorized USB/ADB transfer remain separate options.</p>
    <p role="status" aria-live="polite">{message}</p>
    <div className="setting open"><div className="setting-body"><h3>Encrypted LAN companion</h3>
      <p>Start sharing, open one of the local addresses below on the other device, compare its certificate SHA-256 fingerprint, enter the one-use invitation, then approve the pairing here. Do not approve unexpected devices or certificate fingerprints.</p>
      <div className="choice-row"><button className="install" disabled={busy||state?.running} onClick={()=>act(()=>bridge.start())}>START LOCAL HTTPS</button><button className="choice" disabled={busy||!state?.running} onClick={()=>act(()=>bridge.stop())}>STOP & REVOKE ALL</button></div>
      {state?.running&&<>
        <p>Local addresses (same LAN; allow AEM on private networks in Windows Firewall):</p>
        <ul>{state.urls.map(url=><li key={url}><code>{url}</code></li>)}</ul>
        {!state.urls.length&&<p>No LAN IPv4 interface found. Connect to a private network first.</p>}
        <p>Certificate SHA-256 (compare in the other browser’s certificate details):</p><p style={{overflowWrap:'anywhere'}}><code>{state.fingerprint}</code></p>
        <p>This is an ephemeral self-signed local certificate, not a public CA certificate. If your browser cannot show or verify its fingerprint, use the authorized USB route in Devices instead. AEM does not disable TLS verification for you.</p>
        <label>One-use invitation, valid two minutes<input readOnly value={state.inviteUntil>Date.now()?state.invitation:'Expired or used — create another invitation'} aria-label="One-use invitation"/></label>
        <button className="choice" disabled={busy} onClick={()=>act(()=>bridge.invitation())}>NEW INVITATION</button>
        <h4>Paired devices</h4>{state.peers.length?state.peers.map(p=><p key={p.id}>{p.name} · {p.address} · expires {new Date(p.expiresAt).toLocaleTimeString()} <button className="choice" disabled={busy} onClick={()=>act(()=>bridge.revoke(p.id))}>REVOKE</button></p>):<p>No paired devices. Device labels are user-declared, not publisher identities.</p>}
        <div className="choice-row"><button className="install" disabled={busy} onClick={()=>act(()=>bridge.offer())}>SHARE FILES TO PAIRED DEVICES</button><button className="choice" onClick={()=>act(()=>bridge.showFolder())}>OPEN RECEIVED FILES</button></div>
      </>}
    </div></div>
    <div className="setting open"><div className="setting-body"><h3>Transfer queue</h3>{!state?.files.length&&<p>No files offered yet. Choose files above or send from the paired browser.</p>}{state?.files.map(f=><article key={f.id} className="card compact"><strong>{f.name}</strong><p>{f.direction==='send'?'Shared by PC — receiver verifies before saving':`${f.offset} / ${f.size} bytes · ${f.state==='complete'?'SHA-256 verified and saved':'partial, not installable'}`}</p>{f.direction==='receive'&&<progress max={Math.max(1,f.size)} value={f.state==='complete'?Math.max(1,f.size):f.offset}/> }<small style={{overflowWrap:'anywhere'}}>SHA-256 {f.sha256}</small><button className="choice" disabled={busy} onClick={()=>act(()=>bridge.remove(f.id))}>{f.direction==='send'?'STOP SHARING':f.state==='pending'?'DELETE PARTIAL':'REMOVE FROM QUEUE (KEEP FILE)'}</button></article>)}
      <p className="fine">256 MiB per file, 2 GiB receive quota per session. Uploads resume by reselecting the same file after a network interruption; browser downloads resume while that tab stays open. Stop/revoke invalidates grants and removes unfinished uploads. No automatic installation. mDNS advertises aem-lan/1 to compatible discovery clients; manual addresses work without discovery support. This is not the Android Wi-Fi Direct wire protocol.</p>
    </div></div>
  </section>;
}

/** Desktop Transfer screen: AEM PC ↔ AEM PC pairing, or the generic browser companion. */
export default function DesktopTransfer(){
  const [mode,setMode]=useState<'pc'|'lan'>(()=>localStorage.getItem('aem-transfer-mode')==='lan'?'lan':'pc');
  useEffect(()=>{localStorage.setItem('aem-transfer-mode',mode);},[mode]);
  if(!getDesktop())return null;
  return <>
    <section className="content"><div className="section-head"><div><span>TRANSFER CHANNEL</span><h2>Move files without the cloud</h2></div></div>
      <div className="choice-row">
        <button className={mode==='pc'?'choice active-choice':'choice'} onClick={()=>setMode('pc')} aria-pressed={mode==='pc'}>AEM PC ↔ AEM PC</button>
        <button className={mode==='lan'?'choice active-choice':'choice'} onClick={()=>setMode('lan')} aria-pressed={mode==='lan'}>PHONE / TABLET / BROWSER ↔ PC</button>
      </div>
      <p className="fine">Both channels are local only: files never leave your network, nothing is uploaded, and a received file is never installed or executed by AEM Transfer. Android phone-to-phone Wi-Fi Direct stays in the Android app; authorized USB/ADB transfer lives in the Devices tab.</p>
    </section>
    {mode==='pc'?<PeerTransfer/>:<LanCompanion/>}
  </>;
}
