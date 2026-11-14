/** Generic HTTPS browser companion; NOT the Android Wi-Fi Direct protocol. */
export interface LanFile {id:string;name:string;size:number;sha256:string;offset:number;state:'pending'|'complete';direction:'send'|'receive'}
export interface LanStatus {running:boolean;port:number;fingerprint:string;urls:string[];invitation:string;inviteUntil:number;peers:{id:string;name:string;address:string;expiresAt:number}[];files:LanFile[]}
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
