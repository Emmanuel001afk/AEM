// Real SDK/AVD integration test under Electron, no fake ADB or emulator process.
// Uses the CI-installed SDK; does not claim AEM's SDK downloader or Windows hypervisor coverage.
const {app}=require('electron');
const fs=require('fs');
const path=require('path');
const assert=require('assert/strict');
const {execFile}=require('child_process');
const exec=require('util').promisify(execFile);
const root=path.join(process.env.RUNNER_TEMP||app.getPath('temp'),'aem-managed-emulator-smoke');
fs.mkdirSync(root,{recursive:true});
app.setPath('userData',root);
app.whenReady().then(async()=>{
  const sdk=process.env.ANDROID_SDK_ROOT||process.env.ANDROID_HOME;
  assert.ok(sdk,'CI SDK path required');
  fs.symlinkSync(sdk,path.join(root,'android-sdk'),'dir');
  const {EmulatorManager}=require('../dist-electron/emulator/manager.js');
  const {inspectApk}=require('../dist-electron/emulator/packages.js');
  const manager=EmulatorManager.getInstance();
  const name='aem_ci_runtime';
  try {
    const diagnostics=await manager.getDiagnostics(true);
    fs.writeFileSync('aem-runtime-diagnostics.json',JSON.stringify(diagnostics,null,2));
    assert.equal(diagnostics.summary.canRun,true,diagnostics.recommendation.reasons.join('; '));
    assert.equal((await manager.getSdkStatus()).installed,true);
    await manager.createAvd({name,systemImage:'system-images;android-34;google_apis;x86_64',device:'pixel_7',ramMB:2048,cores:2,heapMB:256,storageMB:2048,gpuMode:'swiftshader_indirect',snapshot:false});
    assert.ok((await manager.listAvds()).some(a=>a.name===name));
    await assert.rejects(()=>manager.createAvd({name,systemImage:'system-images;android-34;google_apis;x86_64'}),/already exists/);
    const status=await manager.start({avdName:name,noWindow:true,bootMode:'cold',gpuMode:'swiftshader_indirect',ramMB:2048,cores:2,extraArgs:['-noaudio','-no-boot-anim']});
    assert.equal(status.state,'running');
    assert.equal(status.bootCompleted,true);
    const apk=path.resolve('release/app-release.apk');
    const metadata=await inspectApk(apk,path.join(root,'android-sdk'));
    await assert.rejects(()=>manager.installApk(apk,{packageIdentity:'com.aem.store',signingCertificateSha256:'00'.repeat(32)}),/certificate mismatch/);
    const installed=await manager.installApk(apk,{packageIdentity:'com.aem.store',signingCertificateSha256:metadata.certificate});
    assert.equal(installed.success,true,installed.message);
    assert.equal((await manager.launchApp('com.aem.store','.MainActivity')).success,true);
    const adb=path.join(sdk,'platform-tools','adb');
    let visible=false;
    for(let i=0;i<12;i++){
      await exec(adb,['-s',status.adbSerial,'shell','uiautomator','dump','/sdcard/aem-ui.xml'],{timeout:15000});
      const {stdout}=await exec(adb,['-s',status.adbSerial,'shell','cat','/sdcard/aem-ui.xml'],{timeout:10000});
      fs.writeFileSync('aem-managed-window.xml',stdout);
      if(/text="(AEM|AEM Store|Home|Your software)/.test(stdout)){visible=true;break;}
      await new Promise(r=>setTimeout(r,2000));
    }
    assert.equal(visible,true,'AEM-managed emulator must show accessible Store UI');
    assert.equal((await manager.uninstallApp('com.aem.store')).success,true);
    await manager.stop();
    assert.equal((await manager.getStatus()).state,'ready');
    assert.equal(await manager.deleteAvd(name),true);
    console.log('::notice title=AEM managed emulator runtime::Real API 34 x86_64 AVD created by AEM, acceleration/resource diagnostics passed, booted, rejected wrong certificate, installed signed APK, launched accessible UI, uninstalled, stopped and deleted AVD. Linux KVM only; SDK preinstalled by CI, not the AEM downloader.');
    app.exit(0);
  } catch(error) {
    fs.writeFileSync('aem-runtime-failure.txt',String(error));
    fs.writeFileSync('aem-runtime-manager.log',(await manager.getLogs(50)).join('\n'));
    console.error('::error title=AEM managed emulator runtime::'+String(error).replaceAll('\n','%0A'));
    try {await manager.stop();}catch{}
    app.exit(1);
  }
}).catch(error=>{fs.writeFileSync('aem-runtime-failure.txt',String(error));console.error('::error title=AEM runtime initialization::'+String(error).replaceAll('\n','%0A'));app.exit(1);});
