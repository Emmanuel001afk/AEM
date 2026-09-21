export type DownloadStatus="queued"|"downloading"|"completed"|"failed"|"cancelled";
export interface DownloadTask{id:string;appId:string;releaseId:string;filename:string;url:string;status:DownloadStatus;bytesDownloaded:number;totalBytes?:number;error?:string;}
export interface DownloadManager{enqueue(task:DownloadTask):Promise<void>;pause(id:string):Promise<void>;resume(id:string):Promise<void>;cancel(id:string):Promise<void>;list():Promise<DownloadTask[]>;}
