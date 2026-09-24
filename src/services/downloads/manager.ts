const AEM_CLIENT_ID_KEY="aem-client-id";
function clientId(){let id=localStorage.getItem(AEM_CLIENT_ID_KEY);if(!id){id=crypto.randomUUID();localStorage.setItem(AEM_CLIENT_ID_KEY,id)}return id}
import {supabaseRequest} from "../supabase/client";
export type DownloadStatus="queued"|"downloading"|"paused"|"installing"|"completed"|"failed"|"cancelled";
export interface DownloadTask{id:string;appId:string;releaseId:string;filename:string;url:string;status:DownloadStatus;bytesDownloaded:number;totalBytes?:number;error?:string;createdAt:string;releaseVersionName?:string;releaseVersionCode?:number;artifactId?:string;packageIdentity?:string;signingCertificateSha256?:string;sha256?:string;installedVersionName?:string;installedVersionCode?:number;}
export async function recordDownload(t:Omit<DownloadTask,"id"|"createdAt">){
 const r=await supabaseRequest("/rest/v1/downloads",{method:"POST",headers:{Prefer:"return=representation","x-aem-client-id":clientId()},body:JSON.stringify({application_id:Number(t.appId),release_id:Number(t.releaseId),filename:t.filename,url:t.url,status:t.status,bytes_downloaded:t.bytesDownloaded,total_bytes:t.totalBytes,error:t.error,client_id:clientId(),release_version_name:t.releaseVersionName,release_version_code:t.releaseVersionCode,artifact_id:t.artifactId?Number(t.artifactId):undefined,package_identity:t.packageIdentity,signing_certificate_sha256:t.signingCertificateSha256,sha256:t.sha256})});
 if(!r.ok) throw new Error(`Download record failed: ${r.status}`); const row=(await r.json())[0];
 await supabaseRequest("/rest/v1/notifications",{method:"POST",body:JSON.stringify({kind:"download",title:"Download started",body:t.filename,app_id:Number(t.appId),release_id:Number(t.releaseId),download_id:row.id,client_id:clientId()})}).catch(()=>{});
 return row;
}
export async function updateDownload(id:string,patch:Partial<DownloadTask>){
 const body:any={}; if(patch.status)body.status=patch.status; if(patch.bytesDownloaded!==undefined)body.bytes_downloaded=patch.bytesDownloaded; if(patch.totalBytes!==undefined)body.total_bytes=patch.totalBytes; if(patch.error!==undefined)body.error=patch.error; if(patch.status==="completed")body.completed_at=new Date().toISOString(); if(patch.installedVersionName!==undefined)body.installed_version_name=patch.installedVersionName; if(patch.installedVersionCode!==undefined)body.installed_version_code=patch.installedVersionCode;
 const r=await supabaseRequest(`/rest/v1/downloads?id=eq.${id}`,{method:"PATCH",headers:{"x-aem-client-id":clientId()},body:JSON.stringify(body)}); if(!r.ok)throw new Error(`Download update failed: ${r.status}`);
 if(patch.status==="completed"||patch.status==="failed"||patch.status==="cancelled"){
   const title=patch.status==="completed"?"Download completed":patch.status==="cancelled"?"Download cancelled":"Download failed";
   await supabaseRequest("/rest/v1/notifications",{method:"POST",body:JSON.stringify({kind:"download",title,body:patch.error||id,download_id:id,client_id:clientId()})}).catch(()=>{});
 }
}
export async function listDownloads(){const r=await supabaseRequest(`/rest/v1/downloads?select=*&client_id=eq.${clientId()}&order=created_at.desc&limit=100`,{headers:{"x-aem-client-id":clientId()}});if(!r.ok)throw new Error(`Download history failed: ${r.status}`);return r.json();}
