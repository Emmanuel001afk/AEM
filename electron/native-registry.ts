import {execFile} from 'child_process';
import {promisify} from 'util';
import path from 'path';
const exec = promisify(execFile);
export interface NativeInstallation {
  packageIdentity:string;
  displayName:string;
  version:string;
  installLocation:string;
  scope:'user'|'machine';
}
export function validateNativeIdentity(identity:unknown):string {
  // Match an exact uninstall subkey, never a display-name substring or command.
  if(typeof identity!=='string'||!(/^[A-Za-z][A-Za-z0-9_.-]{2,199}$/.test(identity)||/^\{[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}\}$/i.test(identity)))throw new Error('Invalid Windows registry package identity');
  return identity;
}
export function normalizeNativeRegistrations(input:unknown,identity:string):NativeInstallation[] {
  validateNativeIdentity(identity);
  const rows = Array.isArray(input)?input:input?[input]:[];
  return rows.filter((r:any)=>r&&r.packageIdentity===identity&&typeof r.displayName==='string'&&typeof r.version==='string'&&/^\d+\.\d+\.\d+(\.\d+)?$/.test(r.version)&&(r.scope==='user'||r.scope==='machine')).map((r:any)=>({packageIdentity:identity,displayName:r.displayName.slice(0,200),version:r.version,installLocation:typeof r.installLocation==='string'?r.installLocation:'',scope:r.scope}));
}
/** Read actual uninstall registration, not a record of having started an installer.
 * Registry identity must come from the publisher; many third-party EXEs use an MSI GUID.
 * Never execute a registry UninstallString/DisplayIcon or infer install success from it.
 */
export async function getNativeInstallations(identity:string):Promise<NativeInstallation[]> {
  validateNativeIdentity(identity);
  if(process.platform!=='win32')throw new Error('Installed Windows version detection requires Windows');
  const script=`$ErrorActionPreference='Stop'
$identity=$env:AEM_NATIVE_IDENTITY
$rows=@()
foreach($hive in @('CurrentUser','LocalMachine')) {
  foreach($view in @('Registry64','Registry32')) {
    $root=$null; $key=$null
    try {
      $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
      $key=$root.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$identity)
      if($key) {
        $scope=if($hive -eq 'CurrentUser'){'user'}else{'machine'}
        $rows+=@{packageIdentity=$identity;displayName=[string]$key.GetValue('DisplayName');version=[string]$key.GetValue('DisplayVersion');installLocation=[string]$key.GetValue('InstallLocation');scope=$scope}
      }
    } finally {if($key){$key.Dispose()}; if($root){$root.Dispose()}}
  }
}
ConvertTo-Json -InputObject @($rows) -Compress`;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,AEM_NATIVE_IDENTITY:identity},timeout:15000,maxBuffer:1024*1024,windowsHide:true});
  const rows=normalizeNativeRegistrations(JSON.parse(stdout.replace(/^\uFEFF/,'')),identity);
  return rows.filter((row,index)=>rows.findIndex(r=>JSON.stringify(r)===JSON.stringify(row))===index);
}
export function nativeUpdateState(installed:NativeInstallation[],available:string):'not-installed'|'update'|'current'|'newer-installed'|'unknown' {
  if(!installed.length)return 'not-installed';
  if(!/^\d+\.\d+\.\d+$/.test(available))return 'unknown';
  const compare=(a:string,b:string)=>{const av=a.split('.').map(Number),bv=b.split('.').map(Number);for(let i=0;i<4;i++){const d=(av[i]||0)-(bv[i]||0);if(d)return Math.sign(d);}return 0;};
  const versions=installed.map(r=>r.version);
  if(versions.some(v=>!/^\d+\.\d+\.\d+(\.\d+)?$/.test(v)))return 'unknown';
  if(versions.some(v=>compare(v,available)>0))return 'newer-installed';
  return versions.some(v=>compare(v,available)<0)?'update':'current';
}
