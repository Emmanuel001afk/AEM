import type {ReleaseEvent,Release} from "../../domain/model";
export interface ReleaseSourceProvider{readonly id:string;verifyEvent(event:ReleaseEvent,signature?:string):Promise<boolean>;normalizeReleaseEvent(event:ReleaseEvent):Promise<Release>}
