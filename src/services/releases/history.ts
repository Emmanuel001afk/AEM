import type {Release} from "../../domain/model";
import {dedupeReleaseHistory,type ReleaseHistoryEntry} from "../../domain/releaseHistory";
import {mapSupabaseRelease} from "../catalog/supabase";
import {supabaseRequest} from "../supabase/client";

export type {ReleaseHistoryEntry} from "../../domain/releaseHistory";

export async function listReleaseHistory(applicationId:number,appMeta:{provider:string;project:string}={provider:"github",project:""}):Promise<ReleaseHistoryEntry[]>{
 const r=await supabaseRequest(`/rest/v1/release_history?select=*,releases(*,artifacts(*))&application_id=eq.${encodeURIComponent(String(applicationId))}&order=created_at.desc`);
 if(!r.ok) throw new Error(`Release history failed: ${r.status}`);
 const rows=await r.json();
 const entries:ReleaseHistoryEntry[]=rows.map((x:any)=>({release:mapSupabaseRelease(appMeta,x.releases),reason:x.reason,createdAt:x.created_at}));
 return dedupeReleaseHistory(entries);
}

export async function setRollbackTarget(applicationId:number,releaseId:number){
 const r=await supabaseRequest(`/rest/v1/applications?id=eq.${encodeURIComponent(String(applicationId))}`,{
  method:"PATCH",headers:{Prefer:"return=minimal"},
  body:JSON.stringify({rollback_release_id:releaseId,updated_at:new Date().toISOString()})
 });
 if(!r.ok) throw new Error(`Rollback target update failed: ${r.status}`);
 await supabaseRequest("/rest/v1/release_history",{method:"POST",body:JSON.stringify({application_id:applicationId,release_id:releaseId,reason:"rollback-target"})});
}
