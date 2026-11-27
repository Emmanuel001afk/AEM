const AEM_CLIENT_ID_KEY="aem-client-id";
function clientId(){let id=localStorage.getItem(AEM_CLIENT_ID_KEY);if(!id){id=crypto.randomUUID();localStorage.setItem(AEM_CLIENT_ID_KEY,id)}return id}
import {supabaseRequest} from "../supabase/client";
export type DownloadStatus="queued"|"downloading"|"paused"|"installing"|"completed"|"failed"|"cancelled";
export interface DownloadTask{id:string;appId:string;releaseId:string;filename:string;url:string;status:DownloadStatus;bytesDownloaded:number;totalBytes?:number;error?:string|null;createdAt:string;releaseVersionName?:string;releaseVersionCode?:number;artifactId?:string;packageIdentity?:string;signingCertificateSha256?:string;sha256?:string;installedVersionName?:string;installedVersionCode?:number;}
const lastProgressSync=new Map<string,number>();
const LOCAL_DOWNLOADS_KEY="aem-local-downloads";
export function readLocalDownloads():any[]{
 try{const value=JSON.parse(localStorage.getItem(LOCAL_DOWNLOADS_KEY)||"[]");return Array.isArray(value)?value:[];}catch{return [];}
}
function writeLocalDownloads(rows:any[]){try{localStorage.setItem(LOCAL_DOWNLOADS_KEY,JSON.stringify(rows.slice(0,100)));}catch{/* Installation must not depend on local storage. */}}
function localDownload(t:Omit<DownloadTask,"id"|"createdAt">){
 const row={id:`local-${crypto.randomUUID()}`,application_id:Number(t.appId),release_id:Number(t.releaseId),filename:t.filename,url:t.url,status:t.status,bytes_downloaded:t.bytesDownloaded,total_bytes:t.totalBytes,release_version_name:t.releaseVersionName,release_version_code:t.releaseVersionCode,artifact_id:t.artifactId,package_identity:t.packageIdentity,sha256:t.sha256,created_at:new Date().toISOString(),local_only:true};
 writeLocalDownloads([row,...readLocalDownloads()]);return row;
}
function assertHttpsUrl(raw:string){
 let parsed:URL;
 try{parsed=new URL(raw);}catch{throw new Error("Invalid download URL");}
 if(parsed.protocol!=="https:")throw new Error("Download URL must use HTTPS");
}
export async function recordDownload(t:Omit<DownloadTask,"id"|"createdAt">){
 assertHttpsUrl(t.url);
 try{
  const r=await supabaseRequest("/rest/v1/downloads",{method:"POST",headers:{Prefer:"return=representation","x-aem-client-id":clientId()},body:JSON.stringify({application_id:Number(t.appId),release_id:Number(t.releaseId),filename:t.filename,url:t.url,status:t.status,bytes_downloaded:t.bytesDownloaded,total_bytes:t.totalBytes,error:t.error,client_id:clientId(),release_version_name:t.releaseVersionName,release_version_code:t.releaseVersionCode,artifact_id:t.artifactId?Number(t.artifactId):undefined,package_identity:t.packageIdentity,signing_certificate_sha256:t.signingCertificateSha256,sha256:t.sha256})});
  if(!r.ok)throw new Error(`Download record failed: ${r.status}`);
  const row=(await r.json())[0];if(!row?.id)throw new Error("Download record missing ID");return row;
 }catch{return localDownload(t);}
}
export async function updateDownload(id:string,patch:Partial<DownloadTask>){
 const safeId=String(id||"").trim();
 if(!safeId)throw new Error("Download id is required");
 const body:any={}; if(patch.status)body.status=patch.status; if(patch.bytesDownloaded!==undefined)body.bytes_downloaded=patch.bytesDownloaded; if(patch.totalBytes!==undefined)body.total_bytes=patch.totalBytes; if(patch.error!==undefined)body.error=patch.error; if(patch.status==="completed")body.completed_at=new Date().toISOString(); if(patch.installedVersionName!==undefined)body.installed_version_name=patch.installedVersionName; if(patch.installedVersionCode!==undefined)body.installed_version_code=patch.installedVersionCode;
 if(patch.status&&patch.status!=="downloading")lastProgressSync.delete(safeId);
 if(safeId.startsWith("local-")){writeLocalDownloads(readLocalDownloads().map(row=>String(row.id)===safeId?{...row,...body}:row));return;}
 const r=await supabaseRequest(`/rest/v1/downloads?id=eq.${encodeURIComponent(safeId)}`,{method:"PATCH",headers:{"x-aem-client-id":clientId()},body:JSON.stringify(body)}); if(!r.ok)throw new Error(`Download update failed: ${r.status}`);
}
export function updateDownloadProgressThrottled(id:string,bytesDownloaded:number,totalBytes:number){
 const now=Date.now();
 const prev=lastProgressSync.get(id)||0;
 if(now-prev<3000&&(totalBytes<=0||bytesDownloaded<totalBytes))return;
 lastProgressSync.set(id,now);
 void updateDownload(id,{status:"downloading",bytesDownloaded,totalBytes}).catch(()=>{});
}
export async function listDownloads(){const r=await supabaseRequest(`/rest/v1/downloads?select=*&client_id=eq.${encodeURIComponent(clientId())}&order=created_at.desc&limit=100`,{headers:{"x-aem-client-id":clientId()}});if(!r.ok)throw new Error(`Download history failed: ${r.status}`);const remote=await r.json();return [...readLocalDownloads(),...remote].sort((a:any,b:any)=>String(b.created_at||"").localeCompare(String(a.created_at||""))).slice(0,100);}
