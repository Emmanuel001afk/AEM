/** AEM-side protocol only. Partners keep their own identity, storage and credentials. */
export const ECOSYSTEM_PROTOCOL = 'aem-capabilities/1' as const;
export const PARTNER_NAMES = ['AEM Store','EMA','OEA','Phormi','Central Hub'] as const;
export type Capability = 'application.metadata.read'|'delivery.request'|'transfer.offer'|'phone.session.request';
export interface PlatformRegistration {
  protocol:typeof ECOSYSTEM_PROTOCOL;
  platformId:string;displayName:typeof PARTNER_NAMES[number];version:string;
  deviceId:string;capabilities:Capability[];
}
export interface CapabilityGrant {peerId:string;deviceId:string;capability:Capability;expiresAt:number;revoked:boolean}
export interface CapabilityRequest {peerId:string;deviceId:string;capability:Capability;requestId:string;protocol:typeof ECOSYSTEM_PROTOCOL}
const capabilities:Set<string>=new Set(['application.metadata.read','delivery.request','transfer.offer','phone.session.request']);
export function validateRegistration(r:PlatformRegistration):boolean{
  return !!r&&r.protocol===ECOSYSTEM_PROTOCOL&&/^[a-zA-Z][\w.-]{2,127}$/.test(r.platformId)&&PARTNER_NAMES.includes(r.displayName)&&/^\d+\.\d+\.\d+$/.test(r.version)&&typeof r.deviceId==='string'&&/^[\w-]{16,128}$/.test(r.deviceId)&&Array.isArray(r.capabilities)&&r.capabilities.length<=4&&new Set(r.capabilities).size===r.capabilities.length&&r.capabilities.every(c=>capabilities.has(c));
}
/** A display name or discovery advertisement is NEVER an authorization grant. Transport must authenticate peer+device before calling. */
export function authorizeCapability(request:CapabilityRequest,authenticated:{peerId:string;deviceId:string},grants:CapabilityGrant[],now=Date.now()):boolean{
  if(!request||request.protocol!==ECOSYSTEM_PROTOCOL||!capabilities.has(request.capability)||!/^[\w-]{16,128}$/.test(request.requestId))return false;
  if(request.peerId!==authenticated.peerId||request.deviceId!==authenticated.deviceId)return false;
  return grants.some(g=>!g.revoked&&g.expiresAt>now&&g.peerId===request.peerId&&g.deviceId===request.deviceId&&g.capability===request.capability);
}
