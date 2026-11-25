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
export interface NativeLookupHints {
  displayNames?: string[];
  executableNames?: string[];
}

export function normalizeNativeRegistrations(input:unknown,identity:string):NativeInstallation[] {
  validateNativeIdentity(identity);
  const rows = Array.isArray(input)?input:input?[input]:[];
  return rows.filter((r:any)=>r&&r.packageIdentity===identity&&typeof r.displayName==='string'&&typeof r.version==='string'&&/^v?\d+\.\d+\.\d+(\.\d+)?$/i.test(r.version.trim())&&(r.scope==='user'||r.scope==='machine')).map((r:any)=>({packageIdentity:identity,displayName:r.displayName.slice(0,200),version:r.version.trim().replace(/^v/i,''),installLocation:typeof r.installLocation==='string'?r.installLocation:'',scope:r.scope}));
}
/** Read actual uninstall registration, not a record of having started an installer.
 * Matches exact uninstall subkey first, then Inno Setup (`<id>_is1`) and verified DisplayName /
 * InstallLocation / executable hints for electron-builder GUID uninstall keys.
 * Never execute a registry UninstallString/DisplayIcon or infer install success from it.
 */
export async function getNativeInstallations(identity:string,lookup?:NativeLookupHints):Promise<NativeInstallation[]> {
  validateNativeIdentity(identity);
  if(process.platform!=='win32')throw new Error('Installed Windows version detection requires Windows');
  const displayNames=Array.isArray(lookup?.displayNames)?lookup!.displayNames.filter((s):s is string=>typeof s==='string'&&s.trim().length>=2).map(s=>s.trim().slice(0,120)).slice(0,10):[];
  const executableNames=Array.isArray(lookup?.executableNames)?lookup!.executableNames.filter((s):s is string=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{1,115}\.exe$/i.test(s.trim())).map(s=>s.trim().toLowerCase()).slice(0,10):[];
  const script=`$ErrorActionPreference='Stop'
$identity=$env:AEM_NATIVE_IDENTITY
$identityLower=$identity.ToLowerInvariant()
$names=@()
if($env:AEM_NATIVE_NAMES){$names=@(($env:AEM_NATIVE_NAMES | ConvertFrom-Json) | ForEach-Object {[string]$_})}
$exes=@()
if($env:AEM_NATIVE_EXES){$exes=@(($env:AEM_NATIVE_EXES | ConvertFrom-Json) | ForEach-Object {[string]$_})}
function Norm([string]$s){if(-not $s){return ''};return ($s.ToLowerInvariant() -replace '[^a-z0-9]+','')}
$normNames=@($names | ForEach-Object {Norm $_} | Where-Object {$_.Length -ge 2})
$normId=Norm $identity
$rows=@()
foreach($hive in @('CurrentUser','LocalMachine')) {
  foreach($view in @('Registry64','Registry32')) {
    $root=$null; $parent=$null
    try {
      $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
      $parent=$root.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
      if(-not $parent){continue}
      $scope=if($hive -eq 'CurrentUser'){'user'}else{'machine'}
      foreach($subName in $parent.GetSubKeyNames()) {
        $sub=$null
        try {
          $sub=$parent.OpenSubKey($subName)
          if(-not $sub){continue}
          $disp=[string]$sub.GetValue('DisplayName')
          $ver=[string]$sub.GetValue('DisplayVersion')
          $loc=[string]$sub.GetValue('InstallLocation')
          $uninst=[string]$sub.GetValue('UninstallString')
          $icon=[string]$sub.GetValue('DisplayIcon')
          $subLower=$subName.ToLowerInvariant()
          $exact=($subLower -eq $identityLower) -or ($subLower -eq ($identityLower+'_is1'))
          $matched=$exact
          if(-not $matched -and $disp -and $ver) {
            $normDisp=Norm $disp
            $haystack=($loc+' '+$uninst+' '+$icon).ToLowerInvariant()
            if($normNames -contains $normDisp){$matched=$true}
            elseif($normId.Length -ge 4 -and $haystack.Contains($identityLower)){$matched=$true}
            elseif($exes.Count -gt 0) {
              foreach($exe in $exes){if($exe -and $haystack.Contains($exe)){$matched=$true;break}}
            }
          }
          if($matched -and $ver) {
            $rows+=@{packageIdentity=$identity;displayName=$disp;version=$ver;installLocation=$loc;scope=$scope}
          }
        } catch {} finally {if($sub){$sub.Dispose()}}
      }
    } finally {if($parent){$parent.Dispose()}; if($root){$root.Dispose()}}
  }
}
ConvertTo-Json -InputObject @($rows) -Compress`;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
    env:{
      ...process.env,
      AEM_NATIVE_IDENTITY:identity,
      AEM_NATIVE_NAMES:JSON.stringify(displayNames),
      AEM_NATIVE_EXES:JSON.stringify(executableNames),
    },
    timeout:15000,
    maxBuffer:1024*1024,
    windowsHide:true,
  });
  const rows=normalizeNativeRegistrations(JSON.parse(stdout.replace(/^\uFEFF/,'')),identity);
  return rows.filter((row,index)=>rows.findIndex(r=>JSON.stringify(r)===JSON.stringify(row))===index);
}
export function nativeUpdateState(installed:NativeInstallation[],available:string):'not-installed'|'update'|'current'|'newer-installed'|'unknown' {
  if(!installed.length)return 'not-installed';
  const cleanAvailable=typeof available==='string'?available.trim().replace(/^v/i,''):'';
  if(!/^\d+\.\d+\.\d+(\.\d+)?$/.test(cleanAvailable))return 'unknown';
  const compare=(a:string,b:string)=>{const av=a.split('.').map(Number),bv=b.split('.').map(Number);for(let i=0;i<4;i++){const d=(av[i]||0)-(bv[i]||0);if(d)return Math.sign(d);}return 0;};
  const versions=installed.map(r=>r.version.trim().replace(/^v/i,''));
  if(versions.some(v=>!/^\d+\.\d+\.\d+(\.\d+)?$/.test(v)))return 'unknown';
  if(versions.some(v=>compare(v,cleanAvailable)>0))return 'newer-installed';
  return versions.some(v=>compare(v,cleanAvailable)<0)?'update':'current';
}
