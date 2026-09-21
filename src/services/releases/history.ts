import type {Release} from "../../domain/model";
import {supabaseRequest} from "../supabase/client";

export interface ReleaseHistoryEntry{release:Release;reason:"published"|"withdrawn"|"rollback-target";createdAt:string;}

export async function listReleaseHistory(applicationId:number):Promise<ReleaseHistoryEntry[]>{
 const r=await supabaseRequest(`/rest/v1/release_history?select=*,releases(*,artifacts(*))&application_id=eq.${applicationId}&order=created_at.desc`);
 if(!r.ok) throw new Error(`Release history failed: ${r.status}`);
 const rows=await r.json();
 return rows.map((x:any)=>({release:x.releases,reason:x.reason,createdAt:x.created_at}));
}

export async function setRollbackTarget(applicationId:number,releaseId:number){
 const r=await supabaseRequest(`/rest/v1/applications?id=eq.${applicationId}`,{
  method:"PATCH",headers:{Prefer:"return=minimal"},
  body:JSON.stringify({rollback_release_id:releaseId,updated_at:new Date().toISOString()})
 });
 if(!r.ok) throw new Error(`Rollback target update failed: ${r.status}`);
 await supabaseRequest("/rest/v1/release_history",{method:"POST",body:JSON.stringify({application_id:applicationId,release_id:releaseId,reason:"rollback-target"})});
}
