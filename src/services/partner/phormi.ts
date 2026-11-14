/** @deprecated Historical adapter shape only. Generic peers use ./contract; no brand whitelist. */
export interface PhormiPartner{readonly protocol:"aem-phormi-v1";discover():Promise<boolean>;getBrowserState():Promise<unknown>;requestPageInspection(request:{url?:string;task?:string}):Promise<unknown>}
