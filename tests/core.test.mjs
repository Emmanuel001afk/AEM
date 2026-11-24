import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const {recommendResources,validateAllocation}=require('../dist-electron/emulator/resources.js');
const {isAllowedExternal,isTrustedRenderer,newerStableVersion,validateAvdName}=require('../dist-electron/security.js');
const {parseBadging,selectPackageSet,validateArchiveEntry}=require('../dist-electron/emulator/packages.js');
const {sdkCommand}=require('../dist-electron/emulator/tool-process.js');
const {parseDevices,packageId,remoteFile}=require('../dist-electron/phone.js');
const {validateRecipe,installerScript,validateWindowsArtifact}=require('../dist-electron/native-delivery.js');
async function domain(file){const source=fs.readFileSync(new URL('../src/domain/'+file,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));}
const host={totalMemMB:8192,freeMemMB:5000,cpuCores:4,diskFreeMB:40000,acceleration:'available',arch:'x64',cpuBusyPercent:20};
test('4 GB Latitude-class memory budget is not marketed as viable',()=>{const p=recommendResources({...host,totalMemMB:4096,freeMemMB:3000});assert.equal(p.supported,false);assert.equal(p.ramMB,0);assert.match(p.reasons.join(' '),/Insufficient comfortable memory/);});
test('comfortable allocation leaves Windows RAM, overhead and cores',()=>{const p=recommendResources(host);assert.equal(p.supported,true);assert.equal(p.ramMB,3072);assert.equal(p.cores,2);assert.ok(p.ramMB+p.hostReserveMB+p.overheadMB<host.totalMemMB);});
test('current pressure overrides installed RAM',()=>{const p=recommendResources({...host,totalMemMB:32768,freeMemMB:2000});assert.equal(p.supported,false);});
test('unknown acceleration, disk and unsupported architecture fail closed',()=>{for(const patch of [{acceleration:'unknown'},{acceleration:'unavailable'},{diskFreeMB:undefined},{diskFreeMB:10000},{arch:'arm64'}])assert.equal(recommendResources({...host,...patch}).supported,false);});
test('manual allocation cannot consume all host resources',()=>{const p=recommendResources(host);assert.throws(()=>validateAllocation(8192,4,p,4));assert.throws(()=>validateAllocation(2048,4,p,4));assert.throws(()=>validateAllocation(NaN,2,p,4));assert.doesNotThrow(()=>validateAllocation(2048,2,p,4));});
test('semantic updates never downgrade or treat error text as versions',()=>{assert.equal(newerStableVersion('v0.2.10','0.2.9'),true);for(const v of ['v0.2.8','0.2.9','Not Found','0.2.10-beta',''])assert.equal(newerStableVersion(v,'0.2.9'),false);});
test('external scheme and IPC origin policy',()=>{for(const url of ['file:///tmp/pwn','javascript:alert(1)','ms-settings:','https://user:pass@x.test'])assert.equal(isAllowedExternal(url),false);assert.equal(isAllowedExternal('https://github.com'),true);assert.equal(isTrustedRenderer('file:///tmp/dist-other/index.html','/tmp/dist/index.html'),false);assert.equal(isTrustedRenderer('file:///tmp/dist/index.html#/apps','/tmp/dist/index.html'),true);assert.equal(isTrustedRenderer('https://evil.test','/tmp/dist/index.html','http://localhost:5173'),false);});
test('AVD traversal and configuration injection rejected',()=>{for(const v of ['../home','a\nb','/tmp/a','a.ini',''])assert.throws(()=>validateAvdName(v));assert.equal(validateAvdName('aem-light_1'),'aem-light_1');});
test('SDK BAT calls quote arguments and reject shell expansion',()=>{const c=sdkCommand('C:\\Android SDK\\sdkmanager.bat',['--install','system-images;android-34;google_apis;x86_64'],'win32');assert.match(c.file,/cmd.exe$/i);assert.equal(c.args[0],'/d');for(const v of ['x & calc','%PATH%','x"y','x\ny','a!PATH!'])assert.throws(()=>sdkCommand('a.bat',[v],'win32'));});
test('archive paths, symlinks and bombs rejected',()=>{for(const name of ['../x.apk','/x.apk','C:x.apk','a\\b.apk','a/../b','a\0b','a./b'])assert.throws(()=>validateArchiveEntry(name,10,10,0));assert.throws(()=>validateArchiveEntry('base.apk',100000,1,0));assert.throws(()=>validateArchiveEntry('base.apk',10,10,0xa000));assert.doesNotThrow(()=>validateArchiveEntry('splits/base.apk',100,80,0x8000));});
const base={file:'base.apk',packageName:'com.example.app',versionCode:12,versionName:'1.2',minSdk:23,abis:[],certificate:'same'};
test('aapt metadata parsing retains API version, ABI and split identity',()=>{const p=parseBadging("package: name='com.example.app' versionCode='12' versionName='1.2' split='config.x86_64'\nsdkVersion:'26'\ntargetSdkVersion:'34'\nnative-code: 'x86_64'\n");assert.equal(p.split,'config.x86_64');assert.equal(p.minSdk,26);assert.deepEqual(p.abis,['x86_64']);assert.throws(()=>parseBadging('PK'));});
test('split set rejects different identities, certificates, versions and alternative bases',()=>{for(const patch of [{certificate:'other'},{packageName:'com.attacker.app'},{versionCode:13}])assert.throws(()=>selectPackageSet([base,{...base,split:'feature',...patch}],{api:34,abis:['x86_64']}));assert.throws(()=>selectPackageSet([base,base],{api:34,abis:['x86_64']}));});
test('split set rejects incompatible API and native architectures',()=>{assert.throws(()=>selectPackageSet([{...base,minSdk:35}],{api:34,abis:['x86_64']}));assert.throws(()=>selectPackageSet([{...base,abis:['arm64-v8a']}],{api:34,abis:['x86_64']}));});
test('device-specific collection keeps feature splits and selects compatible ABI',()=>{const p=selectPackageSet([base,{...base,split:'feature'},{...base,split:'config.arm64_v8a',abis:['arm64-v8a']},{...base,split:'config.x86_64',abis:['x86_64']}],{api:34,abis:['x86_64']});assert.equal(p.length,3);assert.ok(p.some(p=>p.split==='feature'));assert.ok(!p.some(p=>p.split==='config.arm64_v8a'));});
test('phone discovery excludes emulator and reports authorization honestly',()=>{assert.deepEqual(parseDevices('List of devices attached\nemulator-5554 device model:Pixel\nabc unauthorized\nxyz device product:a model:My_Phone\n'),[{serial:'abc',state:'unauthorized',model:'abc'},{serial:'xyz',state:'device',model:'My Phone'}]);});
test('phone package and path shell injection denied',()=>{assert.equal(packageId('com.example.app'),'com.example.app');for(const p of ['a; reboot','com.x $(id)','-x'])assert.throws(()=>packageId(p));for(const p of ['/sdcard/../data/x','/sdcard/x\'','/sdcard/$(id)','/data/user/0/x'])assert.throws(()=>remoteFile(p));assert.equal(remoteFile('/data/app/~~random==/com.example-abc==/base.apk'),'/data/app/~~random==/com.example-abc==/base.apk');});
const recipe={schema:1,familyId:'org.example.notes',androidPackage:'org.example.notes.android',windowsAppId:'org.example.notes.windows',displayName:'Example Notes',version:'1.2.3',project:'windows/Notes.csproj',executable:'Notes.exe',sourceRevision:'reviewed-commit',license:'MIT'};
test('native build requires explicit identities, source provenance and safe paths',()=>{assert.deepEqual(validateRecipe(recipe),recipe);for(const patch of [{project:'../bad.csproj'},{displayName:'A$INSTDIR'},{license:''},{executable:'../bad.exe'},{version:'1.2.999999'},{schema:2}])assert.throws(()=>validateRecipe({...recipe,...patch}));});
test('native installer registers executable and uninstall without deleting app data',()=>{const s=installerScript(recipe,'C:\\work\\app','C:\\work\\Setup.exe');assert.match(s,/CreateShortcut/);assert.match(s,/WriteUninstaller/);assert.match(s,/DisplayVersion/);assert.match(s,/Application data.*retained/);assert.ok(s.includes('$\\"$INSTDIR\\Uninstall.exe$\\"'));assert.throws(()=>installerScript(recipe,'C:\\$bad','C:\\out'));});
test('native catalog delivery rejects missing integrity/identity and insecure URLs',()=>{const artifact={url:'https://example.org/a.exe',filename:'a.exe',sha256:'a'.repeat(64),packageIdentity:'org.example.app',version:'1.0.0'};assert.doesNotThrow(()=>validateWindowsArtifact(artifact));for(const patch of [{version:undefined},{version:'1.2.3-beta'},{sha256:''},{packageIdentity:''},{url:'http://example.org/a.exe'},{filename:'../a.exe'}])assert.throws(()=>validateWindowsArtifact({...artifact,...patch}));});
test('unified methods preserve manual choices and do not invent native availability',async()=>{const {executionMethods}=await domain('delivery.ts');const c={hasAndroidPackage:true,emulatorRunning:false,emulatorCanRun:true,nativeArtifactVerified:false,phoneAuthorized:true,phoneHasApp:true,phoneDisplayAvailable:true};const p=executionMethods(c);assert.equal(p.recommended,'phone');assert.equal(p.options.filter(o=>o.available).length,2);assert.equal(executionMethods({...c,nativeArtifactVerified:true}).recommended,'windows-native');assert.equal(executionMethods({...c,phoneHasApp:false,emulatorCanRun:false}).recommended,null);});
test('partner contracts deny expired, revoked, spoofed and ungranted capabilities',async()=>{const {authorizeCapability}=await domain('ecosystem.ts');const r={protocol:'aem-capabilities/1',peerId:'org.ema',deviceId:'device-12345678901',requestId:'request-123456789',capability:'transfer.offer'};const auth={peerId:r.peerId,deviceId:r.deviceId};const g={...auth,capability:r.capability,expiresAt:200,revoked:false};assert.equal(authorizeCapability(r,auth,[g],100),true);assert.equal(authorizeCapability(r,auth,[],100),false);assert.equal(authorizeCapability(r,{...auth,peerId:'org.phormi'},[g],100),false);assert.equal(authorizeCapability(r,auth,[{...g,revoked:true}],100),false);assert.equal(authorizeCapability(r,auth,[g],300),false);});

test('Windows packaging configuration matches installed electron-builder schema',async()=>{
  const {validateConfiguration}=require('app-builder-lib/out/util/config/config.js');
  const config=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).build;
  await validateConfiguration(config,{isEnabled:false,add(){}});
});

test('Windows variants remain discoverable without changing Android version ordering',async()=>{
 const {selectLatestWindowsRelease}=await domain('version.ts');
 const artifact={platform:'windows',kind:'exe',packageIdentity:'com.example.win',sha256:'a'.repeat(64),downloadUrl:'https://example.org/app.exe'};
 const release=(name,code,channel='stable')=>({id:name,version:{name,code},status:'published',channel,artifacts:[artifact]});
 assert.equal(selectLatestWindowsRelease([release('1.0.9',99999),release('1.0.10',1)]).id,'1.0.10');
 assert.equal(selectLatestWindowsRelease([release('2.0.0',4,'beta'),release('1.0.10',1)]).id,'1.0.10');
 assert.equal(selectLatestWindowsRelease([{...release('9.0.0',1),artifacts:[{...artifact,sha256:''}]}]),undefined);
});

test('Store resolves the laptop and Android host format independently of desktop capabilities',async()=>{
 const {detectHostPlatform,androidArtifact,windowsArtifacts,platformSummary,primaryReleaseInfo,appCardVersion}=await domain('platform.ts');
 assert.equal(detectHostPlatform({desktopPlatform:'win32',nativePlatform:'web'}),'windows');
 assert.equal(detectHostPlatform({nativePlatform:'android',navigatorPlatform:'Win32'}),'android');
 assert.equal(detectHostPlatform({nativePlatform:'web',navigatorPlatform:'Linux armv8l',userAgent:'Mozilla/5.0 (Linux; Android 14)'}),'android');
 assert.equal(detectHostPlatform({nativePlatform:'web',navigatorPlatform:'Win32'}),'windows');
 assert.equal(detectHostPlatform({nativePlatform:'web',navigatorPlatform:'MacIntel'}),'other');
 const apk={platform:'android',kind:'apk',signingStatus:'ready',packageIdentity:'org.example.android',versionCode:12,filename:'example.apk'};
 const exe={platform:'windows',kind:'exe',packageIdentity:'org.example.windows',sha256:'a'.repeat(64),downloadUrl:'https://example.org/example.exe',filename:'example.exe'};
 const app={platforms:['android'],packageIdentity:'org.example.android',latest:{version:{name:'1.2.0',code:12},artifacts:[apk]},windowsLatest:{version:{name:'3.4.5'},artifacts:[exe]}};
 assert.equal(androidArtifact(app.latest,app.packageIdentity),apk);
 assert.deepEqual(windowsArtifacts(app.windowsLatest),[exe]);
 assert.equal(platformSummary(app,'android'),'Android APK · Windows EXE');
 assert.equal(platformSummary(app,'windows'),'Windows EXE · Android APK');
 assert.equal(appCardVersion(app,'android'),'Android APK · Version 1.2.0');
 assert.equal(appCardVersion(app,'windows'),'Windows EXE · Version 3.4.5');
 assert.equal(primaryReleaseInfo(app,'android').platform,'android');
 assert.equal(primaryReleaseInfo(app,'windows').platform,'windows');
 const unverified={...app,windowsLatest:{version:{name:'9.9.9'},artifacts:[{...exe,sha256:''}]}};
 assert.equal(platformSummary(unverified,'windows'),'Android APK');
 assert.match(appCardVersion(unverified,'windows'),/no Windows EXE available/);
});

test('Windows application and APK-association icons are real multi-resolution ICO files',()=>{
 for(const name of ['icon.ico','apk.ico']){
  const b=fs.readFileSync(new URL('../resources/icons/'+name,import.meta.url));
  assert.equal(b.readUInt16LE(0),0);assert.equal(b.readUInt16LE(2),1);
  const count=b.readUInt16LE(4);assert.ok(count>1&&count<=32);
  const sizes=[];
  for(let i=0;i<count;i++){const offset=6+i*16;sizes.push(b[offset]||256);const bytes=b.readUInt32LE(offset+8),start=b.readUInt32LE(offset+12);assert.ok(start>=6+count*16&&start+bytes<=b.length);}
  assert.ok(sizes.includes(32)&&sizes.includes(256));
 }
});

const {validateNativeIdentity,normalizeNativeRegistrations,nativeUpdateState}=require('../dist-electron/native-registry.js');
test('native registry uses exact validated identity and unambiguous registrations',()=>{
 for(const value of ['../key','org.app; echo injected','org.app\\child','*',null,{}])assert.throws(()=>validateNativeIdentity(value));
 assert.equal(validateNativeIdentity('com.publisher.app'),'com.publisher.app');
 assert.doesNotThrow(()=>validateNativeIdentity('{12345678-1234-1234-1234-123456789ABC}'));
 const r={packageIdentity:'com.publisher.app',displayName:'App',version:'1.0.0',scope:'user'};
 assert.equal(normalizeNativeRegistrations([r,{...r,packageIdentity:'other.app'},{...r,version:'unknown'}],r.packageIdentity).length,1);
});
test('native updates compare actual platform versions, reject downgrade, and never equate launch with install',()=>{
 const row=v=>({packageIdentity:'com.publisher.app',displayName:'App',version:v,installLocation:'',scope:'user'});
 assert.equal(nativeUpdateState([],'1.0.0'),'not-installed');
 assert.equal(nativeUpdateState([row('1.0.9')],'1.0.10'),'update');
 assert.equal(nativeUpdateState([row('1.0.10.0')],'1.0.10'),'current');
 assert.equal(nativeUpdateState([row('1.0.10.1')],'1.0.10'),'newer-installed');
 assert.equal(nativeUpdateState([row('1.0.9'),row('2.0.0')],'1.0.10'),'newer-installed');
 assert.equal(nativeUpdateState([row('1.0.10')],'beta'),'unknown');
});
test('catalog signing certificate check is separate from APK signature validity',()=>{
 const {assertCatalogCertificate}=require('../dist-electron/emulator/packages.js');
 const cert='ab'.repeat(32);
 assert.doesNotThrow(()=>assertCatalogCertificate(cert,cert.toUpperCase().match(/../g).join(':')));
 assert.doesNotThrow(()=>assertCatalogCertificate(cert,undefined));
 for(const expected of ['cd'.repeat(32),'xyz',{},1])assert.throws(()=>assertCatalogCertificate(cert,expected));
});

test('signer output parsing accepts SDK spacing/CRLF and rejects unrelated digests',()=>{
 const {parseSignerCertificates}=require('../dist-electron/emulator/packages.js');
 const cert='ab'.repeat(32);
 assert.deepEqual(parseSignerCertificates(`Signer #1 certificate SHA-256 digest: ${cert}\r\n`),[cert]);
 assert.deepEqual(parseSignerCertificates(`Signer #1 certificate SHA256 digest:  ${cert.toUpperCase()}\n`),[cert]);
 assert.deepEqual(parseSignerCertificates(`Source Stamp certificate SHA-256 digest: ${cert}\nSigner #1 public key SHA-256 digest: ${cert}\n`),[]);
});

test('capability registration is application-neutral, not a whitelist of platform names',async()=>{
 const {validateRegistration,authorizeCapability}=await domain('ecosystem.ts');
 const r={protocol:'aem-capabilities/1',platformId:'org.independent.research',displayName:'Independent Research 工具',version:'2.3.4',deviceId:'device-0123456789abcdef',capabilities:['transfer.offer']};
 assert.equal(validateRegistration(r),true);
 assert.equal(validateRegistration({...r,displayName:'EMA'}),true);
 for(const patch of [{displayName:''},{displayName:'a\u202eb'},{platformId:'../admin'},{version:{}},{capabilities:['admin.all']}])assert.equal(validateRegistration({...r,...patch}),false);
 const q={protocol:r.protocol,peerId:r.platformId,deviceId:r.deviceId,requestId:'request-0123456789',capability:'transfer.offer'};
 assert.equal(authorizeCapability(q,{peerId:r.platformId,deviceId:r.deviceId},[]),false);
});
test('generic recognition preserves arbitrary publisher identities without default brands',async()=>{
 const {emptyRecognition,mergeRecognition}=await domain('crossPlatform.ts');
 assert.deepEqual(emptyRecognition(),{recognized:[],notFound:[]});
 const requested=emptyRecognition(['org.example.reader','org.independent.research']);
 const result=mergeRecognition(requested,{recognized:[{platform:'org.example.reader',identity:{appId:'reader.win'}}],notFound:[]});
 assert.deepEqual(result.notFound,['org.independent.research']);assert.equal(result.recognized.length,1);
});
