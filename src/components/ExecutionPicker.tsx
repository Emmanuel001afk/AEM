import {useCallback,useEffect,useMemo,useState} from 'react';
import {executionMethods,type DeliveryContext,type ExecutionMethod} from '../domain/delivery';
import {androidArtifact,normalizeWindowsPackageIdentity,resolveWindowsVersion,windowsArtifacts} from '../domain/platform';
import {getDesktop} from '../services/emulator/contract';
export default function ExecutionPicker({application,onEmulator,onNativeStatusChange}:{application:any;onEmulator:()=>Promise<void>;onNativeStatusChange?:(status:Awaited<ReturnType<NonNullable<ReturnType<typeof getDesktop>>['native']['status']>>)=>void}){
  const desktop=getDesktop();
  if(!desktop)return null;
  const android=androidArtifact(application.latest,application.packageIdentity);
  const allWindows=useMemo(()=>{
    const list=windowsArtifacts(application.windowsLatest);
    return list.length?list:windowsArtifacts(application.latest);
  },[application.windowsLatest,application.latest]);
  const native=allWindows[0];
  const nativeIdentity=native?normalizeWindowsPackageIdentity(native.packageIdentity,application.packageIdentity):'';
  const windowsVersion=native?resolveWindowsVersion(application.windowsLatest||application.latest,native):'';
  const lookupHints=useMemo(()=>({
    displayNames:[String(application.name||''),String(application.id?.project||'').split('/').pop()||''].filter(Boolean),
    executableNames:allWindows.map((a:any)=>String(a.filename||'')).filter(Boolean),
  }),[application.name,application.id?.project,allWindows]);
  const [nativeStatus,setNativeStatus]=useState<Awaited<ReturnType<typeof desktop.native.status>>|null>(null);
  const [nativeError,setNativeError]=useState('');
  const checkNative=useCallback(async()=>{
    if(!native||desktop.platform!=='win32'||!nativeIdentity)return null;
    try{
      const st=await desktop.native.status(nativeIdentity,windowsVersion,lookupHints);
      setNativeStatus(st);
      setNativeError('');
      onNativeStatusChange?.(st);
      return st;
    }catch(e){
      setNativeStatus(null);
      setNativeError(e instanceof Error?e.message:String(e));
      return null;
    }
  },[native,desktop,nativeIdentity,windowsVersion,lookupHints,onNativeStatusChange]);
  const pkg=android?.packageIdentity||application.packageIdentity;
  const [context,setContext]=useState<DeliveryContext>({hasAndroidPackage:!!android,emulatorRunning:false,emulatorCanRun:false,nativeArtifactVerified:!!native&&desktop.platform==='win32',phoneAuthorized:false,phoneHasApp:false,phoneDisplayAvailable:false});
  const [method,setMethod]=useState<ExecutionMethod|null>(null),[serial,setSerial]=useState(''),[phones,setPhones]=useState<{serial:string;model:string}[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const assess=async()=>{
    setBusy(true);setMessage('Checking local capabilities…');
    await checkNative();
    const results=await Promise.allSettled([desktop.emulator.getStatus(),desktop.emulator.getDiagnostics(),desktop.phone.devices(),desktop.phone.status()]);
    const value=(i:number):any=>results[i].status==='fulfilled'?(results[i] as PromiseFulfilledResult<any>).value:null;
    const available=(value(2)||[]).filter((d:any)=>d.state==='device');setPhones(available);
    const phone=available.find((d:any)=>d.serial===serial)||available[0];setSerial(phone?.serial||'');
    let phoneApps:string[]=[];if(phone)phoneApps=await desktop.phone.apps(phone.serial).catch(()=>[]);
    const c={hasAndroidPackage:!!android,emulatorRunning:value(0)?.state==='running',emulatorCanRun:!!value(1)?.summary.canRun,nativeArtifactVerified:!!native&&desktop.platform==='win32',phoneAuthorized:!!phone,phoneHasApp:!!pkg&&phoneApps.includes(pkg),phoneDisplayAvailable:!!value(3)?.scrcpyAvailable};
    setContext(c);setMethod(m=>executionMethods(c).options.some(o=>o.method===m&&o.available)?m:executionMethods(c).recommended);setBusy(false);setMessage('Compatibility is a preflight assessment, not a guarantee that protected or hardware-dependent applications will run.');
  };
  useEffect(()=>{setNativeStatus(null);setNativeError('');setMethod(null);setPhones([]);setSerial('');setContext({hasAndroidPackage:!!android,emulatorRunning:false,emulatorCanRun:false,nativeArtifactVerified:!!native&&desktop.platform==='win32',phoneAuthorized:false,phoneHasApp:false,phoneDisplayAvailable:false});void checkNative();},[application.id?.project,application.latest?.id,application.windowsLatest?.id,checkNative]);
  useEffect(()=>{const onFocus=()=>void checkNative();window.addEventListener('focus',onFocus);return()=>window.removeEventListener('focus',onFocus);},[checkNative]);
  const plan=executionMethods(context);
  const run=async()=>{setBusy(true);try{if(method==='emulator')await onEmulator();else if(method==='phone')await desktop.phone.start(serial,pkg);else if(method==='windows-native'){await desktop.native.install({url:native.downloadUrl,filename:native.filename,sha256:native.sha256,packageIdentity:nativeIdentity,version:windowsVersion});setTimeout(()=>void checkNative(),2500);}setMessage('Request processed. Verify the installer or application window; starting a process is not proof of a completed installation.');}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <div className="setting open"><div className="setting-body"><h3>Choose execution & delivery</h3>
    <p>Recommendation: <strong>{plan.recommended||'check connected capabilities'}</strong>. You can choose any supported method.</p>
    <button className="choice" disabled={busy} onClick={()=>void assess()}>ASSESS AVAILABLE METHODS</button>
    {native&&<div><p>Windows catalog: {windowsVersion||'unknown'} · Registered version(s): {nativeStatus?.installed.map(r=>`${r.version} (${r.scope})`).join(', ')||'not detected'} · {nativeStatus?.state||'not checked'}</p><button className="choice" disabled={busy} onClick={()=>void checkNative()}>REFRESH WINDOWS INSTALLATION STATUS</button><p className="fine">Package identity: {nativeIdentity}. Registration is not proof of a successful app launch. Refresh after completing the installer; updates retain the same identity. {nativeError}</p></div>}
    {phones.length>1&&<label>Phone <select value={serial} onChange={e=>{setSerial(e.target.value);setContext(c=>({...c,phoneHasApp:false}));setMethod(null);setMessage('Phone changed. Assess again to check its installed packages.');}}>{phones.map(p=><option key={p.serial} value={p.serial}>{p.model}</option>)}</select></label>}
    {plan.options.map(option=><label key={option.method} style={{display:'block',margin:'12px 0'}}><input type="radio" name={`method-${application.id?.project}`} checked={method===option.method} disabled={!option.available||busy} onChange={()=>setMethod(option.method)}/> <strong>{option.method==='windows-native'?'Native Windows installer':option.method==='phone'?'Phone-powered display':'Android emulator'}</strong><p>{option.reason}</p></label>)}
    <button className="install" disabled={busy||!plan.options.some(o=>o.method===method&&o.available)} onClick={()=>void run()}>CONTINUE WITH SELECTED METHOD</button>
    <p role="status" aria-live="polite">{message}</p>
  </div></div>;
}
