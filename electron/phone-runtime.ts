import {app} from 'electron';
import fs from 'fs';
import path from 'path';
import {PhoneManager} from './phone';
import {getSdkRoot} from './config';
let manager:PhoneManager|undefined;
function settingsFile(){return path.join(app.getPath('userData'),'phone-tools.json');}
export function phoneManager(){
  if(!manager){
    let tools:{adb?:string;scrcpy?:string}={};try{tools=JSON.parse(fs.readFileSync(settingsFile(),'utf8'));}catch{}
    manager=new PhoneManager(typeof tools.adb==='string'?tools.adb:path.join(getSdkRoot(),'platform-tools',process.platform==='win32'?'adb.exe':'adb'),typeof tools.scrcpy==='string'?tools.scrcpy:null,path.join(app.getPath('downloads'),'AEM Transfer'));
  }
  return manager;
}
export function configurePhoneTools(dir:string){
  const adb=path.join(dir,process.platform==='win32'?'adb.exe':'adb');
  const scrcpy=path.join(dir,process.platform==='win32'?'scrcpy.exe':'scrcpy');
  if(!fs.existsSync(adb)||!fs.existsSync(scrcpy))throw new Error('Selected directory must contain scrcpy and adb from your trusted local installation');
  phoneManager().configure(adb,scrcpy);fs.writeFileSync(settingsFile(),JSON.stringify({adb,scrcpy}),{mode:0o600});
  return phoneManager().status();
}
export function stopPhone(){manager?.stop();}
