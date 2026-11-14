import fs from 'fs';
import path from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {downloadVerified} from './download';
const exec=promisify(execFile);
export interface NativeRecipe {
  schema:1; familyId:string; androidPackage?:string; windowsAppId:string;
  displayName:string; version:string; project:string; executable:string;
  sourceRevision:string; license:string;
}
export function validateRecipe(value:unknown):NativeRecipe {
  const r=value as NativeRecipe;
  if(!r||r.schema!==1)throw new Error('Expected AEM native recipe schema 1');
  const id=/^[a-zA-Z][\w-]*(\.[a-zA-Z][\w-]*)+$/;
  if(!id.test(r.familyId)||!id.test(r.windowsAppId)||(r.androidPackage&&!/^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/.test(r.androidPackage)))throw new Error('Invalid application identities');
  if(typeof r.displayName!=='string'||!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(r.displayName))throw new Error('Unsafe product name');
  if(typeof r.version!=='string'||!/^\d+\.\d+\.\d+$/.test(r.version)||r.version.split('.').some(n=>Number(n)>65535))throw new Error('Version must be a Windows-compatible numeric triple');
  if(typeof r.project!=='string'||!r.project.endsWith('.csproj')||path.isAbsolute(r.project)||r.project.split(/[\\/]/).includes('..')||/["$\r\n%]/.test(r.project))throw new Error('Project must be a relative .csproj within the selected source tree');
  if(typeof r.executable!=='string'||!/^[A-Za-z0-9][\w.-]*\.exe$/.test(r.executable))throw new Error('Invalid published executable name');
  if(typeof r.sourceRevision!=='string'||!r.sourceRevision.trim()||r.sourceRevision.length>200||typeof r.license!=='string'||!r.license.trim()||r.license.length>200)throw new Error('Source revision and licensing provenance are required');
  return r;
}
function nsisPath(value:string){if(/["$\r\n]/.test(value))throw new Error('NSIS build path contains unsupported characters');return value;}
export function installerScript(r:NativeRecipe,publishDir:string,output:string):string{
  validateRecipe(r);nsisPath(publishDir);nsisPath(output);
  return `Unicode true
!include "MUI2.nsh"
Name "${r.displayName}"
OutFile "${output}"
InstallDir "$LOCALAPPDATA\\Programs\\${r.windowsAppId}"
InstallDirRegKey HKCU "Software\\${r.windowsAppId}" "InstallDir"
RequestExecutionLevel user
VIProductVersion "${r.version}.0"
VIAddVersionKey "ProductName" "${r.displayName}"
VIAddVersionKey "FileDescription" "${r.displayName} Setup"
VIAddVersionKey "FileVersion" "${r.version}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section
  SetOutPath "$INSTDIR"
  File /r "${publishDir}\\*"
  WriteRegStr HKCU "Software\\${r.windowsAppId}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\\${r.displayName}.lnk" "$INSTDIR\\${r.executable}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${r.windowsAppId}" "DisplayName" "${r.displayName}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${r.windowsAppId}" "DisplayVersion" "${r.version}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${r.windowsAppId}" "DisplayIcon" "$INSTDIR\\${r.executable}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${r.windowsAppId}" "UninstallString" '${String.fromCharCode(36,92,34)}$INSTDIR\\Uninstall.exe${String.fromCharCode(36,92,34)}'
SectionEnd
Section "Uninstall"
  Delete "$SMPROGRAMS\\${r.displayName}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${r.windowsAppId}"
  DeleteRegKey HKCU "Software\\${r.windowsAppId}"
  ; Application data belongs to the app and is deliberately retained.
SectionEnd
`;
}
/** Only adapted WinForms/WPF sources are accepted. This does not translate Android bytecode. */
export async function buildNativeSource(recipePath:string,makensis:string,outputRoot:string){
  if(process.platform!=='win32')throw new Error('Native Windows builds require Windows, .NET SDK and NSIS');
  const recipe=validateRecipe(JSON.parse(await fs.promises.readFile(recipePath,'utf8')));
  const source=await fs.promises.realpath(path.dirname(recipePath));
  const project=await fs.promises.realpath(path.join(source,recipe.project));
  const relative=path.relative(source,project);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Project resolves outside source directory');
  const xml=await fs.promises.readFile(project,'utf8');
  if(!/<ApplicationIcon>[^<]+<\/ApplicationIcon>/.test(xml))throw new Error('Adapted project must declare its own ApplicationIcon; AEM does not invent publisher branding');
  if(!/<Use(?:WindowsForms|WPF)>true<\//.test(xml)||!/<TargetFramework>net[\d.]+-windows/.test(xml))throw new Error('Requires a genuine Windows-targeted WinForms/WPF source adaptation; wrappers and Android APKs are not native ports');
  await fs.promises.mkdir(outputRoot,{recursive:true});
  const work=await fs.promises.mkdtemp(path.join(outputRoot,'native-'));
  const published=path.join(work,'application');
  try{
    await exec('dotnet',['publish',project,'--configuration','Release','--runtime','win-x64','--self-contained','true','-p:PublishSingleFile=true',`-p:Version=${recipe.version}`,'--output',published],{timeout:20*60*1000,maxBuffer:16*1024**2,windowsHide:true});
    const exe=path.join(published,recipe.executable);
    if(!fs.existsSync(exe))throw new Error('Declared Windows executable was not produced');
    const setup=path.join(work,`${recipe.windowsAppId}-${recipe.version}-Setup-x64.exe`);
    const script=path.join(work,'installer.nsi');await fs.promises.writeFile(script,installerScript(recipe,published,setup));
    await exec(makensis,[script],{timeout:10*60*1000,maxBuffer:8*1024**2,windowsHide:true});
    if(!fs.existsSync(setup))throw new Error('NSIS did not produce installer');
    const {hashFile}=await import('./phone');
    const result={...recipe,platform:'windows',kind:'exe',filename:path.basename(setup),sha256:await hashFile(setup),builtAt:new Date().toISOString()};
    await fs.promises.writeFile(path.join(work,'aem-native-release.json'),JSON.stringify(result,null,2));
    return {path:setup,manifest:result};
  }catch(e:any){throw new Error(`Native build failed: ${e.message}. Logs/output retained at ${work}`);}
}
export interface WindowsArtifact {url:string;filename:string;sha256:string;packageIdentity:string}
export function validateWindowsArtifact(a:WindowsArtifact){
  if(!a||typeof a.filename!=='string'||!/^[\w.-]+\.exe$/i.test(a.filename)||!/^([a-f\d]{64})$/i.test(a.sha256)||!a.packageIdentity||!/^https:\/\//.test(a.url))throw new Error('Windows variant requires HTTPS, EXE filename, SHA-256 and platform package identity');
}
export async function stageWindowsArtifact(a:WindowsArtifact,root:string){
  validateWindowsArtifact(a);if(process.platform!=='win32')throw new Error('Windows installers can only run on Windows');
  const dir=await fs.promises.mkdtemp(path.join(root,'native-install-'));const file=path.join(dir,a.filename);
  try{await downloadVerified(a.url,file,a.sha256);const fd=await fs.promises.open(file,'r');const header=Buffer.alloc(64);try{await fd.read(header,0,64,0);}finally{await fd.close();}if(header.toString('ascii',0,2)!=='MZ')throw new Error('Downloaded file is not a Windows executable');return file;}
  catch(e){await fs.promises.rm(dir,{recursive:true,force:true});throw e;}
}
