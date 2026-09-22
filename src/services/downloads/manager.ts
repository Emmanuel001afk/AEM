import {supabaseRequest} from "../supabase/client";
export type DownloadStatus="queued"|"downloading"|"paused"|"installing"|"completed"|"failed"|"cancelled";
export interface DownloadTask{id:string;appId:string;releaseId:string;filename:string;url:string;status:DownloadStatus;bytesDownloaded:number;totalBytes?:number;error?:string;createdAt:string;}
export async function recordDownload(t:Omit<DownloadTask,"id"|"createdAt">){
 const r=await supabaseRequest("/rest/v1/downloads",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({application_id:Number(t.appId),release_id:Number(t.releaseId),filename:t.filename,url:t.url,status:t.status,bytes_downloaded:t.bytesDownloaded,total_bytes:t.totalBytes,error:t.error})});
 if(!r.ok) throw new Error(`Download record failed: ${r.status}`); return (await r.json())[0];
}
export async function updateDownload(id:string,patch:Partial<DownloadTask>){
 const body:any={}; if(patch.status)body.status=patch.status; if(patch.bytesDownloaded!==undefined)body.bytes_downloaded=patch.bytesDownloaded; if(patch.totalBytes!==undefined)body.total_bytes=patch.totalBytes; if(patch.error!==undefined)body.error=patch.error; if(patch.status==="completed")body.completed_at=new Date().toISOString();
 const r=await supabaseRequest(`/rest/v1/downloads?id=eq.${id}`,{method:"PATCH",body:JSON.stringify(body)}); if(!r.ok)throw new Error(`Download update failed: ${r.status}`);
}
export async function listDownloads(){const r=await supabaseRequest("/rest/v1/downloads?select=*&order=created_at.desc&limit=100");if(!r.ok)throw new Error(`Download history failed: ${r.status}`);return r.json();}
