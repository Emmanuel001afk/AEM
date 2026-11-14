export type ExecutionMethod = 'emulator'|'windows-native'|'phone';
export interface MethodOption {method:ExecutionMethod;available:boolean;reason:string}
export interface DeliveryContext {
  hasAndroidPackage:boolean; emulatorRunning:boolean; emulatorCanRun:boolean;
  nativeArtifactVerified:boolean; phoneAuthorized:boolean; phoneHasApp:boolean; phoneDisplayAvailable:boolean;
}
/** Availability is evidence-based; a source URL alone never makes an app a native Windows port. */
export function executionMethods(c:DeliveryContext):{options:MethodOption[];recommended:ExecutionMethod|null}{
  const options:MethodOption[]=[
    {method:'windows-native',available:c.nativeArtifactVerified,reason:c.nativeArtifactVerified?'Publisher-supplied Windows variant with identity and integrity metadata. Installation still requires consent.':'No verified Windows variant. Android binaries cannot be converted without an actual source adaptation.'},
    {method:'phone',available:c.phoneAuthorized&&c.phoneHasApp&&c.phoneDisplayAvailable,reason:!c.phoneAuthorized?'Connect and authorize an Android phone.':!c.phoneHasApp?'This package is not installed or visible on the selected phone.':!c.phoneDisplayAvailable?'Select trusted local scrcpy tools.':'Runs on the authorized phone, displayed and controlled on this PC. Not OEM desktop mode.'},
    {method:'emulator',available:c.hasAndroidPackage&&(c.emulatorRunning||c.emulatorCanRun),reason:!c.hasAndroidPackage?'No Android package is available.':c.emulatorRunning||c.emulatorCanRun?'Package API, ABI and signatures will be checked before installation. Play services, DRM and hardware compatibility remain app-dependent.':'Emulator is not ready or host resources/acceleration are insufficient. See Diagnostics.'},
  ];
  return {options,recommended:options.find(o=>o.available)?.method??null};
}
export interface ApplicationFamily {
  familyId:string; displayName:string;
  variants:Array<{platform:'android'|'windows';packageId:string;versionName:string;androidVersionCode?:number;sourceRevision?:string}>;
}
export const AEM_FAMILY:ApplicationFamily={familyId:'com.aem.store',displayName:'AEM Store',variants:[{platform:'android',packageId:'com.aem.store',versionName:'0.1.0'},{platform:'windows',packageId:'com.aem.store',versionName:'0.1.0'}]};
