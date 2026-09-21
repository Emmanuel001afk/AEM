import type {InstalledApplication,Release,InstallDecision} from "../../domain/model";
import {compareAndroidRelease} from "../../domain/version";

export function getInstallDecision(release:Release,installed:InstalledApplication|undefined):InstallDecision {
    if(!installed) return {state:"not-installed",action:"INSTALL",reason:"Application is not installed"};
    const state=compareAndroidRelease(release,installed);
    if(state==="update-available") return {state,action:"UPDATE",reason:"A compatible newer release is available"};
    if(state==="installed") return {state,action:"OPEN",reason:"Installed version matches the store release"};
    if(state==="local-newer") return {state,action:"CURRENT",reason:"Installed version is newer than this release"};
    return {state:"identity-mismatch",action:"INCOMPATIBLE",reason:"Package identity or signing certificate does not match"};
}

export function getInstallAction(release:Release,installed:InstalledApplication|undefined){
    return getInstallDecision(release,installed).action;
}
