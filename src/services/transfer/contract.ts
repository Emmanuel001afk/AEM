/** Generic HTTPS browser companion (`aem-lan/1`); NOT the Android Wi-Fi Direct protocol. */
export interface LanFile {id:string;name:string;size:number;sha256:string;offset:number;state:'pending'|'complete';direction:'send'|'receive'}
export interface LanStatus {running:boolean;port:number;fingerprint:string;urls:string[];invitation:string;inviteUntil:number;peers:{id:string;name:string;address:string;expiresAt:number}[];files:LanFile[]}

/* AEM desktop ↔ desktop (`aem-peer/1`). Two paired AEM PCs, pinned TLS, HMAC-signed requests,
 * explicit consent on both ends, per-chunk + whole-file SHA-256, resumable offsets. */
export type PeerTransferState='queued'|'pending'|'complete'|'declined'|'cancelled'|'failed';
export interface PeerInfo {id:string;name:string;address:string;port:number;fingerprint:string;sas:string;addedAt:number;lastSeenAt:number}
export interface PeerDiscovered {id:string;name:string;address:string;port:number;fingerprint:string;seenAt:number;paired:boolean}
export interface PeerTransfer {id:string;name:string;size:number;sha256:string;offset:number;state:PeerTransferState;direction:'send'|'receive';peerName:string;updatedAt:number;error?:string}
export interface PeerHistoryRow {at:number;direction:'send'|'receive';peer:string;name:string;size:number;sha256:string;state:'complete'|'declined'|'cancelled'|'failed';note?:string}
export interface PeerStatus {
  running:boolean;protocol:string;id:string;name:string;fingerprint:string;port:number;urls:string[];
  invitation:string|null;inviteUntil:number;peers:PeerInfo[];discovered:PeerDiscovered[];
  transfers:PeerTransfer[];history:PeerHistoryRow[];maxFileBytes:number;chunkBytes:number;receiveDir:string;
}
export interface PeerEvent {type:string;at:number;peer?:string;transferId?:string;name?:string;offset?:number;size?:number;message?:string}
export interface PeerBridge {
  status():Promise<PeerStatus>;
  start():Promise<PeerStatus|null>;
  stop():Promise<PeerStatus>;
  invite():Promise<PeerStatus>;
  name(name:string):Promise<PeerStatus>;
  pair(code:string):Promise<PeerStatus>;
  unpair(peerId:string):Promise<PeerStatus>;
  send(peerId:string):Promise<PeerStatus|null>;
  resume(transferId:string):Promise<PeerStatus>;
  cancel(transferId:string):Promise<PeerStatus>;
  remove(transferId:string):Promise<PeerStatus>;
  clearHistory():Promise<PeerStatus>;
  probe(address:string,port:number):Promise<{id:string;name:string;fingerprint:string;protocol:string;port:number}|null>;
  showFolder():Promise<void>;
  onEvent(cb:(event:PeerEvent)=>void):()=>void;
}

export interface TransferBridge {
  status():Promise<LanStatus>;
  start():Promise<LanStatus|null>;
  invitation():Promise<LanStatus>;
  stop():Promise<void>;
  offer():Promise<LanStatus|null>;
  revoke(id:string):Promise<void>;
  remove(id:string):Promise<LanStatus>;
  showFolder():Promise<void>;
}
