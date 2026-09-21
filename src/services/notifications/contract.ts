import {supabaseRequest} from "../supabase/client";
export type NotificationKind="update"|"download"|"release"|"security"|"system";
export interface AemNotification{id:string;kind:NotificationKind;title:string;body:string;createdAt:string;read:boolean;action?:{type:"app"|"release"|"download";id:string};}
export async function listNotifications(){const r=await supabaseRequest("/rest/v1/notifications?select=*&order=created_at.desc&limit=100");if(!r.ok)throw new Error(`Notifications failed: ${r.status}`);return r.json();}
export async function markNotificationRead(id:string){const r=await supabaseRequest(`/rest/v1/notifications?id=eq.${id}`,{method:"PATCH",body:JSON.stringify({read:true})});if(!r.ok)throw new Error(`Notification update failed: ${r.status}`);}
export async function createNotification(n:{kind:NotificationKind;title:string;body:string;app_id?:number;release_id?:number}){const r=await supabaseRequest("/rest/v1/notifications",{method:"POST",body:JSON.stringify(n)});if(!r.ok)throw new Error(`Notification create failed: ${r.status}`);}
