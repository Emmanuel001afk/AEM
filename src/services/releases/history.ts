import type {Release} from "../../domain/model";
export interface ReleaseHistoryEntry{release:Release;reason:"published"|"withdrawn"|"rollback-target";createdAt:string;}
export interface ReleaseHistory{list(applicationId:string):Promise<ReleaseHistoryEntry[]>;setRollbackTarget(applicationId:string,releaseId:string):Promise<void>;}
