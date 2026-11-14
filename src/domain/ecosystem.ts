/** Open, application-neutral protocol. Each peer owns its identity, data and credentials. */
export const ECOSYSTEM_PROTOCOL = 'aem-capabilities/1' as const;
export const CAPABILITIES = ['application.metadata.read','delivery.request','transfer.offer','phone.session.request'] as const;
export type Capability = typeof CAPABILITIES[number];
export interface PlatformRegistration {
  protocol:typeof ECOSYSTEM_PROTOCOL;
  platformId:string;displayName:string;version:string;
  deviceId:string;capabilities:Capability[];
}
export interface CapabilityGrant {peerId:string;deviceId:string;capability:Capability;expiresAt:number;revoked:boolean}
export interface CapabilityRequest {peerId:string;deviceId:string;capability:Capability;requestId:string;protocol:typeof ECOSYSTEM_PROTOCOL}
const capabilities:ReadonlySet<string>=new Set(CAPABILITIES);
export function validPlatformId(v:unknown):v is string{return typeof v==='string'&&/^[a-zA-Z][\w-]*(\.[a-zA-Z][\w-]*)+$/.test(v)&&v.length<=128;}
export function validateRegistration(value:unknown):value is PlatformRegistration{
  if(!value||typeof value!=='object')return false;
  const r=value as PlatformRegistration;
  return r.protocol===ECOSYSTEM_PROTOCOL&&validPlatformId(r.platformId)&&typeof r.displayName==='string'&&r.displayName.trim().length>0&&r.displayName.length<=100&&!/[\p{Cc}\p{Cf}]/u.test(r.displayName)&&typeof r.version==='string'&&/^\d+\.\d+\.\d+$/.test(r.version)&&r.version.split('.').every(n=>Number.isSafeInteger(Number(n)))&&typeof r.deviceId==='string'&&/^[\w-]{16,128}$/.test(r.deviceId)&&Array.isArray(r.capabilities)&&r.capabilities.length<=CAPABILITIES.length&&new Set(r.capabilities).size===r.capabilities.length&&r.capabilities.every(c=>capabilities.has(c));
}
/** Transport MUST authenticate peer/device. Neither a brand name nor an advertisement grants access. */
export function authorizeCapability(request:CapabilityRequest,authenticated:{peerId:string;deviceId:string},grants:CapabilityGrant[],now=Date.now()):boolean{
  if(!request||request.protocol!==ECOSYSTEM_PROTOCOL||!capabilities.has(request.capability)||!validPlatformId(request.peerId)||typeof request.deviceId!=='string'||!/^[\w-]{16,128}$/.test(request.deviceId)||typeof request.requestId!=='string'||!/^[\w-]{16,128}$/.test(request.requestId)||!Number.isFinite(now))return false;
  if(request.peerId!==authenticated.peerId||request.deviceId!==authenticated.deviceId)return false;
  return grants.some(g=>g.revoked===false&&Number.isFinite(g.expiresAt)&&g.expiresAt>now&&g.peerId===request.peerId&&g.deviceId===request.deviceId&&g.capability===request.capability);
}
