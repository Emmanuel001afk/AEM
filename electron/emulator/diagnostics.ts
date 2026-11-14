import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getEmulatorPath } from './sdk';
import { recommendResources } from './resources';
import type { DiagnosticsResult, DiagnosticCheck, HostRequirements } from './types';
const run = promisify(execFile);
const requirements: HostRequirements = {
  minRamMB: 4096, recommendedRamMB: 8192, minDiskMB: 20480, recommendedDiskMB: 30720,
  minCpuCores: 2, virtualizationRequired: true, hyperVModes: ['WHPX','AEHD','KVM'],
  supportedGpuModes: ['auto','host','swiftshader_indirect'],
};
async function cpuLoad(): Promise<number> {
  const sample = () => os.cpus().map(c=>({idle:c.times.idle,total:Object.values(c.times).reduce((a,b)=>a+b,0)}));
  const a=sample(); await new Promise(r=>setTimeout(r,200)); const b=sample();
  const total=b.reduce((n,c,i)=>n+c.total-(a[i]?.total??c.total),0);
  const idle=b.reduce((n,c,i)=>n+c.idle-(a[i]?.idle??c.idle),0);
  return total ? Math.round(100*(1-idle/total)) : 0;
}
export async function runDiagnostics(userDataPath = os.homedir()): Promise<DiagnosticsResult> {
  let diskFreeMB: number | undefined;
  try { const d = await fs.promises.statfs(userDataPath); diskFreeMB = Math.floor(d.bavail*d.bsize/1048576); } catch {}
  let acceleration: 'available'|'unavailable'|'unknown' = 'unknown';
  let accelerationDetails = 'SDK emulator not installed; acceleration has not been tested.';
  const emulator = getEmulatorPath();
  if (fs.existsSync(emulator)) {
    try {
      const {stdout,stderr} = await run(emulator,['-accel-check'],{timeout:15000,windowsHide:true});
      accelerationDetails=(stdout+'\n'+stderr).trim().slice(0,2000);
      // The official emulator probe's exit status is authoritative, not localized systeminfo words.
      acceleration='available';
    } catch(e: any) { acceleration='unavailable'; accelerationDetails=String(e.stdout||e.stderr||e.message).slice(0,2000); }
  }
  let gpuInfo: string | undefined;
  try {
    if (process.platform === 'win32') {
      const {stdout} = await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress'],{timeout:8000,windowsHide:true});
      gpuInfo=stdout.trim().slice(0,1500);
    }
  } catch {}
  const cpus=os.cpus();
  const host={totalMemMB:Math.floor(os.totalmem()/1048576),freeMemMB:Math.floor(os.freemem()/1048576),cpuCores:cpus.length||1,cpuModel:cpus[0]?.model||'Unknown',osVersion:`${os.type()} ${os.release()} ${os.arch()}`,diskFreeMB,gpuInfo,virtualizationEnabled:acceleration==='available',hypervisor:accelerationDetails,cpuBusyPercent:await cpuLoad()};
  const recommendation=recommendResources({...host,arch:process.arch,acceleration});
  const checks: DiagnosticCheck[] = [
    {id:'virtualization',label:'Emulator acceleration probe',status:acceleration==='available'?'pass':acceleration==='unknown'?'warn':'fail',message:accelerationDetails,required:true,fix:acceleration==='available'?undefined:'Install SDK, enable VT-x/AMD-V and Windows Hypervisor Platform, then rerun. No BIOS or security setting is changed automatically.'},
    {id:'ram',label:'Host memory budget',status:recommendation.ramMB?'pass':'fail',message:`${host.totalMemMB} MB total; ${host.freeMemMB} MB available; ${recommendation.hostReserveMB} MB OS/AEM reserve + ${recommendation.overheadMB} MB emulator overhead.`,required:true},
    {id:'disk',label:'Free storage',status:diskFreeMB!==undefined&&diskFreeMB>=20480?'pass':'fail',message:diskFreeMB===undefined?'Unable to measure storage':`${diskFreeMB} MB available at ${userDataPath}`,required:true},
    {id:'cpu',label:'Processor',status:host.cpuCores>=2?'pass':'fail',message:`${host.cpuModel}; ${host.cpuCores} logical cores; sampled load ${host.cpuBusyPercent}%`,required:true},
    {id:'gpu',label:'Graphics (not benchmarked)',status:'info',message:gpuInfo||'GPU/driver information unavailable. Auto mode is a request, not proof of working acceleration.',required:false},
    ...recommendation.reasons.map((message,i):DiagnosticCheck=>({id:`budget-${i}`,label:'Resource constraint',status:'fail',message,required:true})),
    ...recommendation.warnings.map((message,i):DiagnosticCheck=>({id:`warning-${i}`,label:'Resource guidance',status:'warn',message,required:false})),
  ];
  return {timestamp:new Date().toISOString(),platform:process.platform,arch:process.arch,checks,requirements,host,recommendation,summary:{passed:checks.filter(c=>c.status==='pass').length,warnings:checks.filter(c=>c.status==='warn').length,failed:checks.filter(c=>c.status==='fail').length,canRun:recommendation.supported}};
}
