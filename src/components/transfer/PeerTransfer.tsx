import {useCallback,useEffect,useMemo,useState} from 'react';
import {getDesktop} from '../../services/emulator/contract';
import type {PeerStatus,PeerTransfer} from '../../services/transfer/contract';

const stateLabel:Record<string,string>={
  queued:'waiting to start',pending:'in progress',complete:'SHA-256 verified and saved',
  declined:'declined on the receiving PC',cancelled:'cancelled',failed:'interrupted',
};

function bytes(v:number){
  if(!Number.isFinite(v)||v<0)return '0 B';
  const units=['B','KB','MB','GB','TB'];let i=0,n=v;
  while(n>=1024&&i<units.length-1){n/=1024;i++;}
  return `${n.toFixed(n>=10||i===0?0:1)} ${units[i]}`;
}

/** AEM ↔ AEM desktop transfer (`aem-peer/1`): pairing, consent, hashing and resume all live in the
 * Electron main process. This screen only reads status and asks the main process to act. */
export default function PeerTransfer(){
  const bridge=getDesktop()?.peer;
  const [status,setStatus]=useState<PeerStatus|null>(null);
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [code,setCode]=useState('');
  const [name,setName]=useState<string|null>(null);
  const running=status?.running??false;

  const refresh=useCallback(async()=>{if(!bridge)return null;try{return await bridge.status();}catch{return null;}},[bridge]);
  useEffect(()=>{let live=true;const tick=()=>{void refresh().then(s=>{if(live&&s)setStatus(s);});};tick();const timer=setInterval(tick,1500);return()=>{live=false;clearInterval(timer);};},[refresh]);
  useEffect(()=>bridge?.onEvent(e=>{
    if(e.type==='completed'||e.type==='failed'||e.type==='declined'||e.type==='paired'||e.type==='unpaired'||e.type==='invite')void refresh().then(s=>{if(s)setStatus(s);});
    if(e.message)setMessage(`${e.peer?e.peer+' · ':''}${e.name?e.name+' · ':''}${e.message}`);
  })??undefined,[bridge,refresh]);

  const act=useCallback(async(fn:()=>Promise<unknown>,done?:string)=>{
    setBusy(true);
    try{await fn();if(done)setMessage(done);const s=await refresh();if(s)setStatus(s);}
    catch(e){setMessage(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  },[refresh]);

  const totals=useMemo(()=>{
    const list=status?.transfers??[];
    const active=list.filter(t=>t.state==='pending'||t.state==='queued');
    const offset=active.reduce((s,t)=>s+Math.min(t.offset,t.size),0), size=active.reduce((s,t)=>s+t.size,0);
    return {active:active.length,offset,size};
  },[status]);

  if(!bridge)return null;
  const inviteActive=!!status?.invitation&&(status.inviteUntil??0)>Date.now();
  return <section className="content">
    <div className="section-head"><div><span>AEM PC ↔ AEM PC · LOCAL ONLY</span><h2>Desktop to desktop transfer</h2></div><span className="transfer-pill">{running?`SHARING · ${status?.peers.length??0} PAIRED PC${status?.peers.length===1?'':'S'}`:'SHARING OFF'}</span></div>
    <p>Pair two computers running AEM Store, then move files across your local network. There is no server, no upload and no account: each PC presents a pinned certificate, both PCs must approve pairing, and every file is checked against a full SHA-256 hash before it appears in <em>Downloads/AEM Transfer</em>. Received files are never executed or installed by AEM Transfer.</p>
    <p role="status" aria-live="polite">{message||'Idle.'}</p>

    <div className="setting open"><div className="setting-body">
      <h3>This PC</h3>
      <p>Your PC is identified by a locally generated certificate; the label is only what the other person sees and is not a verified identity. Keep sharing on and the pairing survives a restart, but a stopped session never resumes unfinished transfers.</p>
      <div className="choice-row">
        <input className="peer-field" aria-label="This PC name" value={name??status?.name??''} onChange={e=>setName(e.target.value)} disabled={busy||!status} placeholder={status?.name||'Loading…'}/>
        <button className="choice" disabled={busy||!name?.trim()||name.trim()===status?.name} onClick={()=>{const next=(name??'').trim().slice(0,80);void act(async()=>{await bridge.name(next);setName(null);},'PC name saved. The other PCs still show their stored label until they re-pair.');}}>RENAME THIS PC</button>
      </div>
      <div className="choice-row">
        <button className="install" disabled={busy||running} onClick={()=>act(async()=>{const s=await bridge.start();if(s)setStatus(s);},'PC-to-PC sharing is listening.')}>START PC-TO-PC SHARING</button>
        <button className="choice" disabled={busy||!running} onClick={()=>act(async()=>{setStatus(await bridge.stop());},'Sharing stopped; every pairing key on this PC stays local and transfers were dropped.')}>STOP &amp; DROP TRANSFERS</button>
        <button className="choice" disabled={!running} onClick={()=>act(async()=>{setStatus(await bridge.invite());},'New one-use invitation created.')}>NEW INVITATION</button>
        <button className="choice" onClick={()=>act(()=>bridge.showFolder(),'Opened Downloads/AEM Transfer.')}>OPEN RECEIVED FILES</button>
      </div>
      {running&&<>
        <p>This PC listens on (allow AEM on private networks in Windows Firewall; never forward this port):</p>
        <ul>{status!.urls.map(u=><li key={u}><code>{u}</code></li>)}</ul>
        {!status!.urls.length&&<p>No LAN IPv4 address found — connect to a private network first.</p>}
        <p>Certificate SHA-256 (stable for this PC; the other PC pins it):</p>
        <p style={{overflowWrap:'anywhere'}}><code>{status!.fingerprint}</code></p>
        <h4>Invitation for the other PC</h4>
        {inviteActive?<>
          <p>Valid {Math.max(0,Math.round((status!.inviteUntil-Date.now())/1000))}s more, single use. Paste or copy it into a channel you already trust, then approve the pairing dialog on <em>both</em> PCs and only if the 6-digit code matches on both screens.</p>
          <textarea className="peer-field peer-code" readOnly value={status!.invitation??''} aria-label="AEM PC invitation code" rows={3}/>
          <div className="choice-row"><button className="choice" onClick={()=>{void navigator.clipboard?.writeText(status!.invitation??'').then(()=>setMessage('Invitation copied.'),()=>setMessage('Copying was blocked — select the code and copy it manually.'));}}>COPY INVITATION</button></div>
        </>:<p>No active invitation. Choose NEW INVITATION; the code expires after 5 minutes or on first use.</p>}
        <h4>Pair with an invitation from another PC</h4>
        <div className="choice-row">
          <input className="peer-field" aria-label="Invitation code from another PC" value={code} onChange={e=>setCode(e.target.value)} placeholder="Paste the other PC's AEM1-… invitation code" disabled={busy||!running}/>
          <button className="install" disabled={busy||!running||code.trim().length<20} onClick={()=>act(async()=>{setStatus(await bridge.pair(code.trim()));setCode('');},'Paired. Confirm the code shown on both PCs.')}>PAIR</button>
        </div>
      </>}
      {!running&&<p>Start sharing to pair with another AEM PC. The Android phone-to-phone transfer and the browser companion are separate channels.</p>}
    </div></div>

    <div className="setting open"><div className="setting-body">
      <h3>Paired PCs</h3>
      {status&&!status.peers.length&&<p>Nothing paired yet. Create an invitation here and paste the other PC’s invitation code.</p>}
      {status?.peers.map(p=><article className="card compact" key={p.id}>
        <strong>{p.name}</strong>
        <p>{p.address}:{p.port} · last seen {p.lastSeenAt?new Date(p.lastSeenAt).toLocaleString():'never'} · confirmation code <b>{p.sas}</b></p>
        <small style={{overflowWrap:'anywhere'}}>certificate SHA-256 {p.fingerprint}</small>
        <div className="choice-row">
          <button className="install" disabled={busy||!running} onClick={()=>act(async()=>{setStatus(await bridge.send(p.id));},'Sending — approve the file dialog on the receiving PC.')}>SEND FILES…</button>
          <button className="choice" disabled={busy} onClick={()=>act(async()=>{setStatus(await bridge.unpair(p.id));},'Pairing revoked on this PC; unpair it on the other PC too.')}>UNPAIR</button>
        </div>
      </article>)}
      {!!status?.discovered.length&&<>
        <h4>Advertised on this network (mDNS <code>_aem-peer._tcp</code>)</h4>
        <p className="fine">Discovery is not authorization — an advertised PC still needs an invitation code and your approval.</p>
        {status.discovered.map(d=><p key={d.id}>{d.name} · {d.address}:{d.port} · {d.paired?'paired':'not paired'}</p>)}
      </>}
    </div></div>

    <div className="setting open"><div className="setting-body">
      <h3>Transfer queue</h3>
      {!status?.transfers.length&&<p>No transfers in this session. Send from a paired PC above, or wait for an incoming file prompt.</p>}
      {totals.active>0&&<p>{totals.active} active · {bytes(totals.offset)} / {bytes(totals.size)} committed by the receiving PC. Paused or interrupted transfers resume from the last verified chunk.</p>}
      {status?.transfers.map(t=><PeerRow key={t.id} transfer={t} busy={busy}
        onResume={()=>act(async()=>{setStatus(await bridge.resume(t.id));},'Resuming from the receiver’s committed offset.')}
        onCancel={()=>act(async()=>{setStatus(await bridge.cancel(t.id));},'Cancelled; the other PC dropped its partial file.')}
        onRemove={()=>act(async()=>{setStatus(await bridge.remove(t.id));},'Removed from the queue. The saved file stays in Downloads/AEM Transfer.')}/>) }
      <p className="fine">Limits per session: {bytes(status?.maxFileBytes??0)} per file, {bytes(status?.chunkBytes??0)} chunks, 64 queued files, 8 peers, 32 GiB received total, 2 GiB free space kept on disk. Both directions are verified per chunk and again over the whole file before a file is finalized.</p>
    </div></div>

    <div className="setting open"><div className="setting-body">
      <h3>History <span className="peer-muted">stored on this PC only</span></h3>
      {!status?.history.length&&<p>Nothing recorded yet.</p>}
      {status?.history.slice(0,20).map((h,i)=><p key={`${h.at}-${i}`}>{new Date(h.at).toLocaleString()} · {h.direction==='send'?'sent to':'received from'} {h.peer} · <b>{h.name}</b> · {bytes(h.size)} · {h.state}{h.note?` (${h.note})`:''}</p>)}
      {!!status?.history.length&&<div className="choice-row"><button className="choice" disabled={busy} onClick={()=>act(async()=>{setStatus(await bridge.clearHistory());},'History cleared.')}>CLEAR HISTORY</button></div>}
    </div></div>
  </section>;
}

function PeerRow({transfer,busy,onResume,onCancel,onRemove}:{transfer:PeerTransfer;busy:boolean;onResume:()=>void;onCancel:()=>void;onRemove:()=>void}){
  const pct=transfer.size>0?Math.min(100,Math.round(Math.min(transfer.offset,transfer.size)/transfer.size*100)):0;
  return <article className="card compact peer-queue">
    <strong>{transfer.name}</strong>
    <p>{transfer.direction==='send'?`Sending to ${transfer.peerName}`:`From ${transfer.peerName}`} · {bytes(Math.min(transfer.offset,transfer.size))} / {bytes(transfer.size)} · {stateLabel[transfer.state]??transfer.state}{transfer.error?` — ${transfer.error}`:''}</p>
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${transfer.name} progress`}><div className="progress-fill" style={{width:`${transfer.state==='complete'?100:pct}%`}}/></div>
    <small style={{overflowWrap:'anywhere'}}>SHA-256 {transfer.sha256||'not hashed yet'}</small>
    <div className="choice-row">
      {transfer.direction==='send'&&transfer.state!=='complete'&&transfer.state!=='queued'&&<button className="choice" disabled={busy} onClick={onResume}>RESUME</button>}
      {transfer.state!=='complete'&&<button className="choice" disabled={busy} onClick={onCancel}>CANCEL</button>}
      {transfer.state==='complete'&&<button className="choice" disabled={busy} onClick={onRemove}>REMOVE FROM QUEUE</button>}
    </div>
  </article>;
}
