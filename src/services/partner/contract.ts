import type {PlatformRegistration,CapabilityRequest} from '../../domain/ecosystem';
/** Optional adapter for any independently owned application. Registration is not authorization.
 * No installed adapter or live connection is implied by this TypeScript contract.
 */
export interface ApplicationPeer {
  registration:PlatformRegistration;
  request(request:CapabilityRequest,payload:unknown):Promise<unknown>;
  disconnect():Promise<void>;
}
