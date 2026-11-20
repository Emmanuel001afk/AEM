import {TransferService} from "./transfer/service";
import {PeerTransferService} from "./transfer/peer";
import {getNativeInstallations,nativeUpdateState} from "./native-registry";
import { ipcMain, dialog, shell, app, BrowserWindow } from "electron";
import path from "path";
import { buildNativeSource, stageWindowsArtifact, validateWindowsArtifact, validateRecipe, type WindowsArtifact } from "./native-delivery";
import fs from "fs";
import { phoneManager, configurePhoneTools } from "./phone-runtime";
import { isAllowedExternal, isTrustedRenderer, newerStableVersion } from "./security";
import { EmulatorManager } from "./emulator/manager";

export function registerIpc(mainWindow: BrowserWindow) {
  const emu = EmulatorManager.getInstance();
  const transferRoot=path.join(app.getPath('downloads'),'AEM Transfer');
  const transfer=new TransferService({root:transferRoot,assets:path.join(__dirname,'transfer','web'),consent:async(request)=>{
    const result=await dialog.showMessageBox(mainWindow,{type:'question',buttons:['Reject','Allow'],defaultId:0,cancelId:0,message:request.kind==='pair'?'Allow this device to access locally shared files?':'Receive this file?',detail:request.kind==='pair'?`Unverified device label: ${request.name}. Network address: ${request.address}. Only approve the device you invited; compare the TLS fingerprint out of band first. Grant expires in one hour.`:`${request.name} (${request.size} bytes) from ${request.address}. SHA-256: ${request.sha256}. This saves a file only; nothing is executed or installed.`});
    return result.response===1;
  }});
  mainWindow.once('closed',()=>{void transfer.stop();});
  // AEM ↔ AEM desktop pairing. Shares the receive folder with the LAN companion and Android client,
  // but runs its own server, identity key and consent prompts (docs/pc-transfer.md).
  const peerStateRoot=path.join(app.getPath('userData'),'aem-peer');
  const peer=new PeerTransferService({root:transferRoot,stateDir:peerStateRoot,consent:async request=>{
    if(request.kind==='receive'){
      const result=await dialog.showMessageBox(mainWindow,{type:'question',buttons:['Decline','Accept and save'],defaultId:0,cancelId:0,message:'Receive this file from a paired PC?',detail:`${request.name} — ${request.size} bytes\nFrom paired PC: ${request.peer}\nSHA-256: ${request.sha256}\n\nThis saves a file in Downloads/AEM Transfer after a full checksum match. Nothing is executed or installed.`});
      return result.response===1;
    }
    const outgoing=request.kind==='pair-out';
    const result=await dialog.showMessageBox(mainWindow,{type:'question',buttons:['Reject','Pair'],defaultId:0,cancelId:0,message:outgoing?'Pair this AEM PC with that AEM PC?':'Another AEM PC wants to pair with this one',detail:`${request.peer} · ${request.address}\nCertificate SHA-256: ${request.fingerprint}\nConfirmation code: ${request.sas}\n\nAsk the person on the other PC to read their code aloud and approve only if both codes match. Device labels are user-declared, not verified identities. A pairing grants file transfer only — no screen, input, registry, database or installer access.`});
    return result.response===1;
  },onEvent:event=>{try{mainWindow.webContents.send('aem:peerEvent',event);}catch{}}});
  mainWindow.once('closed',()=>{void peer.stop();});
  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
          !isTrustedRenderer(event.senderFrame.url, path.join(__dirname, "../dist/index.html"), app.isPackaged ? undefined : process.env.AEM_DEV_URL)) {
        throw new Error("Untrusted IPC sender");
      }
      return listener(event, ...args);
    });
  };

  // System
  handle("aem:openExternal", async (_e, url: string) => {
    if (!isAllowedExternal(url)) throw new Error("Only HTTP(S) links may be opened externally");
    await shell.openExternal(url);
    return true;
  });
  handle("aem:showItemInFolder", async (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
    return true;
  });
  handle("aem:getAppPath", async (_e, name: string) => {
    try { return app.getPath(name as any); } catch { return app.getPath("userData"); }
  });
  handle("aem:getVersion", async () => app.getVersion());
  handle("aem:checkForUpdates", async () => {
    // Simple GitHub releases check
    try {
      const response = await fetch("https://api.github.com/repos/Emmanuel001afk/AEM/releases/latest", {
        headers: { "User-Agent": "AEM-Store", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 404) return { available: false, current: app.getVersion() };
      if (!response.ok) throw new Error(`Release lookup HTTP ${response.status}`);
      const data: any = await response.json();
      if (data.draft || data.prerelease || !Array.isArray(data.assets) || !data.assets.some((a: any) => /-Setup-x64\.exe$/.test(a.name))) return { available: false };
      const latest = String(data.tag_name || data.name || "");
      const current = app.getVersion();
      return { available: newerStableVersion(latest, current), latest, current, url: data.html_url };
    } catch (e: any) {
      return { available: false, error: e.message };
    }
  });

  handle("aem:pickApkFile", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "Select Android APK",
      filters: [
        { name: "Android Packages", extensions: ["apk", "apks", "xapk", "apkm", "zip"] },
        { name: "All Files", extensions: ["*"] },
      ],
      properties: ["openFile", "multiSelections"],
    });
    return { canceled: r.canceled, filePaths: r.filePaths };
  });

  handle("aem:pickFile", async (_e, opts: any) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: opts?.title || "Select File",
      filters: opts?.filters || [{ name: "All Files", extensions: ["*"] }],
      properties: ["openFile", "multiSelections"],
    });
    return { canceled: r.canceled, filePaths: r.filePaths };
  });

  handle("aem:saveFile", async (_e, opts: any) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: opts?.title || "Save File",
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    return { canceled: r.canceled, filePath: r.filePath };
  });

  handle("native:build",async()=>{
    if(process.platform!=="win32")throw new Error("Windows source builds require a Windows host");
    const pick=await dialog.showOpenDialog(mainWindow,{title:"Choose adapted Windows source recipe",filters:[{name:"AEM native recipe",extensions:["json"]}],properties:["openFile"]});
    if(pick.canceled)return null;
    const recipe=validateRecipe(JSON.parse(fs.readFileSync(pick.filePaths[0],"utf8")));
    const consent=await dialog.showMessageBox(mainWindow,{type:"warning",buttons:["Cancel","Trust and build source"],defaultId:0,cancelId:0,message:`Build ${recipe.displayName} ${recipe.version} for Windows?`,detail:`This executes MSBuild from your selected source with your user permissions. Only proceed with source you trust and are licensed to build. This is not APK conversion. Family: ${recipe.familyId}; source: ${recipe.sourceRevision}; license: ${recipe.license}. Requires .NET SDK and local NSIS. Build completion is not installation/launch verification.`});
    if(consent.response!==1)return null;
    const compiler=await dialog.showOpenDialog(mainWindow,{title:"Choose trusted NSIS makensis.exe",filters:[{name:"NSIS compiler",extensions:["exe"]}],properties:["openFile"]});
    if(compiler.canceled)return null;
    if(path.basename(compiler.filePaths[0]).toLowerCase()!=="makensis.exe")throw new Error("Select the NSIS compiler makensis.exe");
    return buildNativeSource(pick.filePaths[0],compiler.filePaths[0],path.join(app.getPath("downloads"),"AEM Native Builds"));
  });
  handle("native:status",async(_e,identity:string,version:string)=>{
    const installed=await getNativeInstallations(identity);
    return {installed,state:nativeUpdateState(installed,version)};
  });
  handle("native:install",async(_e,artifact:WindowsArtifact)=>{
    validateWindowsArtifact(artifact);
    const installed=await getNativeInstallations(artifact.packageIdentity);
    const state=nativeUpdateState(installed,artifact.version);
    if(state==='newer-installed')throw new Error('A newer registered Windows version is already installed. AEM will not initiate a downgrade.');
    const consent=await dialog.showMessageBox(mainWindow,{type:"warning",buttons:["Cancel","Download verified installer"],defaultId:0,cancelId:0,message:"Install a publisher-provided Windows application?",detail:`${String(artifact?.packageIdentity).slice(0,200)} — ${String(artifact?.filename).slice(0,200)}. SHA-256 verifies catalog integrity, not publisher trust. Review the publisher and Windows security prompt; AEM does not silently execute installers.`});
    if(consent.response!==1)return null;
    const file=await stageWindowsArtifact(artifact,app.getPath("temp"));
    const launch=await dialog.showMessageBox(mainWindow,{type:"question",buttons:["Keep download only","Run installer"],defaultId:0,cancelId:0,message:"Checksum verified. Run the Windows installer?",detail:file});
    if(launch.response===1){const error=await shell.openPath(file);if(error)throw new Error(error);}
    return {path:file,launched:launch.response===1};
  });

  handle('transfer:status',()=>transfer.status());
  handle('transfer:start',async()=>{
    const c=await dialog.showMessageBox(mainWindow,{type:'warning',buttons:['Cancel','Start local HTTPS sharing'],defaultId:0,cancelId:0,message:'Open a local HTTPS transfer endpoint?',detail:'Other devices on your network can connect. Pairing requires a one-use invitation and your approval. Verify the certificate fingerprint on the other device. Only selected files are shared. Use a trusted private network; do not forward this port on your router.'});
    return c.response===1?transfer.start():null;
  });
  handle('transfer:invitation',()=>transfer.newInvitation());
  handle('transfer:stop',()=>transfer.stop());
  handle('transfer:revoke',(_e,id:string)=>transfer.revoke(id));
  handle('transfer:remove',(_e,id:string)=>transfer.remove(id));
  handle('transfer:showFolder',async()=>{await fs.promises.mkdir(transferRoot,{recursive:true});const e=await shell.openPath(transferRoot);if(e)throw new Error(e);});
  handle('transfer:offer',async()=>{
    const pick=await dialog.showOpenDialog(mainWindow,{title:'Share selected files with paired LAN devices',properties:['openFile','multiSelections']});
    return pick.canceled?null:transfer.offer(pick.filePaths);
  });

  // PC ↔ PC (aem-peer/1). Every privileged action is confirmed by a native dialog on both PCs.
  handle('peer:status',async()=>peer.status());
  handle('peer:start',async()=>{
    const c=await dialog.showMessageBox(mainWindow,{type:'warning',buttons:['Cancel','Start PC-to-PC sharing'],defaultId:0,cancelId:0,message:'Open the AEM PC-to-PC transfer endpoint?',detail:'This PC listens on your local network for one paired AEM PC at a time. Pairing needs an invitation you create, a matching confirmation code on both PCs and your approval here. Only files you explicitly select can move; nothing is ever installed. Use a trusted private network and do not forward this port on your router.'});
    return c.response===1?peer.start():null;
  });
  handle('peer:stop',async()=>{await peer.stop();return peer.status();});
  handle('peer:invite',async()=>peer.newInvite());
  handle('peer:name',async(_e,name:string)=>peer.setName(String(name??'')));
  handle('peer:pair',async(_e,code:string)=>{
    const status=await peer.pairWith(String(code??''));
    const sas=status.peers[0]?.sas??'n/a';
    dialog.showMessageBox(mainWindow,{type:'info',buttons:['OK'],message:'Paired with the other AEM PC',detail:`If the 6-digit code on the other screen was not ${sas}, unpair now — a mismatch means something else is on that address.\n\nThis pairing only allows consented file copies: no screen, input or app data is shared.`}).catch(()=>{});
    return status;
  });
  handle('peer:unpair',async(_e,id:string)=>peer.unpair(String(id??'')));
  handle('peer:send',async(_e,peerId:string)=>{
    const pick=await dialog.showOpenDialog(mainWindow,{title:'Send files to the paired AEM PC',properties:['openFile','multiSelections']});
    return pick.canceled?null:peer.send(String(peerId),pick.filePaths);
  });
  handle('peer:resume',async(_e,id:string)=>peer.resume(String(id)));
  handle('peer:cancel',async(_e,id:string)=>peer.cancel(String(id)));
  handle('peer:remove',async(_e,id:string)=>peer.remove(String(id)));
  handle('peer:clearHistory',async()=>peer.clearHistory());
  handle('peer:probe',async(_e,address:string,port:number)=>peer.probe({address:String(address),port:Number(port)}));
  handle('peer:showFolder',async()=>{await fs.promises.mkdir(transferRoot,{recursive:true});const e=await shell.openPath(transferRoot);if(e)throw new Error(e);});

  // Phone operations are independent of the emulator and use Android-authorized ADB only.
  handle("phone:devices", () => phoneManager().devices());
  handle("phone:status", () => phoneManager().status());
  handle("phone:apps", (_e, serial: string) => phoneManager().listApps(serial));
  handle("phone:configure", async () => {
    const consent = await dialog.showMessageBox(mainWindow,{type:"warning",buttons:["Cancel","Choose trusted tools"],defaultId:0,cancelId:0,message:"Choose a trusted local scrcpy installation",detail:"AEM will execute scrcpy and adb from this directory. Obtain them from the official Genymobile/scrcpy project and verify their release checksums. Do not select tools received from an unknown sender."});
    if(consent.response!==1)return null;
    const pick=await dialog.showOpenDialog(mainWindow,{title:"Select scrcpy directory containing scrcpy and adb",properties:["openDirectory"]});
    return pick.canceled?null:configurePhoneTools(pick.filePaths[0]);
  });
  handle("phone:start",async (_e,serial:string,pkg?:string)=>{
    const consent=await dialog.showMessageBox(mainWindow,{type:"question",buttons:["Cancel","Start phone display"],defaultId:0,cancelId:0,message:"Display and control your authorized phone?",detail:"The application runs on the phone. Its screen and input are shared with this PC through scrcpy. Protected content may be black. Unlock the phone and approve Android's debugging authorization. Stop the session or unplug to disconnect."});
    if(consent.response!==1)throw new Error("Phone display cancelled");
    return phoneManager().start(serial,pkg);
  });
  handle("phone:stop",()=>phoneManager().stop());
  handle("phone:send",async (_e,serial:string)=>{
    const pick=await dialog.showOpenDialog(mainWindow,{title:"Send file to authorized phone Downloads/AEM-Transfer",properties:["openFile"]});
    return pick.canceled?null:phoneManager().push(serial,pick.filePaths[0]);
  });
  handle("phone:receive",async (_e,serial:string,remote:string)=>{
    const consent=await dialog.showMessageBox(mainWindow,{type:"question",buttons:["Cancel","Receive file"],defaultId:0,cancelId:0,message:"Receive phone file into Downloads/AEM Transfer?",detail:String(remote).slice(0,1024)});
    return consent.response!==1?null:phoneManager().pull(serial,remote);
  });
  handle("phone:export",async (_e,serial:string,pkg:string)=>{
    const consent=await dialog.showMessageBox(mainWindow,{type:"question",buttons:["Cancel","Export package files"],defaultId:0,cancelId:0,message:"Export accessible base and split APKs?",detail:`${pkg} — only export applications you are permitted to copy. App data, Play ownership, account entitlements and protected services are not transferred.`});
    return consent.response!==1?null:phoneManager().exportPackage(serial,pkg);
  });

  // Emulator
  handle("emulator:getResourceProfiles",()=>emu.getResourceProfiles());
  handle("emulator:getStatus", async () => emu.getStatus());
  handle("emulator:getDiagnostics", async (_e, force?: boolean) => emu.getDiagnostics(!!force));
  handle("emulator:getSdkStatus", async () => emu.getSdkStatus());
  handle("emulator:installSdk", async () => {
    const consent = await dialog.showMessageBox(mainWindow, {type:"question", buttons:["Cancel","Accept and install"],defaultId:0,cancelId:0,message:"Install Android SDK components?", detail:"Requires Java and several GB of downloads/storage. Review the Android SDK terms at https://developer.android.com/studio/terms before accepting. AEM will pass your acceptance to sdkmanager; it does not bypass licensing."});
    if (consent.response !== 1) throw new Error("SDK installation cancelled");
    return emu.installSdk(p => {
      try { mainWindow.webContents.send("emulator:sdkProgress", p); } catch {}
    });
  });
  handle("emulator:listAvds", async () => emu.listAvds());
  handle("emulator:getAvdInfo", async (_e, name: string) => emu.getAvdInfo(name));
  handle("emulator:listSystemImages", async () => emu.listSystemImages());
  handle("emulator:createAvd", async (_e, opts: any) => emu.createAvd(opts));
  handle("emulator:deleteAvd", async (_e, name: string) => emu.deleteAvd(name));
  handle("emulator:wipeAvd", async (_e, name: string) => emu.wipeAvd(name));
  handle("emulator:updateAvd", async (_e, name: string, patch: any) => emu.updateAvd(name, patch));

  handle("emulator:start", async (_e, opts: any) => emu.start(opts));
  handle("emulator:stop", async () => emu.stop());
  handle("emulator:restart", async (_e, opts: any) => emu.restart(opts));

  handle("emulator:getInstalledApps", async () => emu.getInstalledApps());
  handle("emulator:installApk", async (_e, filePath: string, opts: any) => emu.installApk(filePath, opts));
  handle("emulator:installApkFromUrl", async (_e, url: string, fileName: string) => emu.installApkFromUrl(url, fileName));
  handle("emulator:uninstallApp", async (_e, pkg: string, keepData?: boolean) => emu.uninstallApp(pkg, !!keepData));
  handle("emulator:launchApp", async (_e, pkg: string, activity?: string) => emu.launchApp(pkg, activity));
  handle("emulator:getAppInfo", async (_e, pkg: string) => emu.getAppInfo(pkg));
  handle("emulator:getAppPermissions", async (_e, pkg: string) => emu.getAppPermissions(pkg));
  handle("emulator:grantPermission", async (_e, pkg: string, perm: string) => emu.grantPermission(pkg, perm));
  handle("emulator:revokePermission", async (_e, pkg: string, perm: string) => emu.revokePermission(pkg, perm));
  handle("emulator:clearAppData", async (_e, pkg: string) => emu.clearAppData(pkg));
  handle("emulator:forceStop", async (_e, pkg: string) => emu.forceStop(pkg));

  handle("emulator:pushFile", async (_e, localPath: string, remotePath: string) => emu.pushFile(localPath, remotePath));
  handle("emulator:pullFile", async (_e, remotePath: string, localPath: string) => emu.pullFile(remotePath, localPath));
  handle("emulator:shell", async (_e, cmd: string) => emu.shell(cmd));
  handle("emulator:getApkInfo", async (_e, filePath: string) => emu.getApkInfo(filePath));
  handle("emulator:takeScreenshot", async () => emu.takeScreenshot());
  handle("emulator:setLocation", async (_e, lat: number, lng: number) => emu.setLocation(lat, lng));
  handle("emulator:rotate", async (_e, r: number) => emu.rotate(r as any));

  handle("emulator:getLogs", async (_e, limit?: number) => emu.getLogs(limit));

  handle("emulator:installStoreArtifact", async (_e, artifact: { url: string; filename: string; sha256?: string; packageIdentity?: string; signingCertificateSha256?: string }) => {
    if (!artifact.sha256) throw new Error("Catalog artifact is missing SHA-256; refresh verified release metadata before installation");
    return emu.installApkFromUrl(artifact.url, artifact.filename, artifact.sha256, artifact.packageIdentity, artifact.signingCertificateSha256);
  });
}
