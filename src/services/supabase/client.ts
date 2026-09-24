export const AEM_SUPABASE_URL="https://wfvvmyixqcwosmuldxoq.supabase.co";
const DEFAULT_PUBLISHABLE_KEY="sb_publishable_Imgtr_W_Z868cBsNEcWpeg_89FE2Mvb";
export function getSupabasePublishableKey(){return import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||DEFAULT_PUBLISHABLE_KEY;}
const AEM_CLIENT_ID_KEY="aem-client-id";
function getClientId(){let id=localStorage.getItem(AEM_CLIENT_ID_KEY);if(!id){id=crypto.randomUUID();localStorage.setItem(AEM_CLIENT_ID_KEY,id)}return id;}
export async function supabaseRequest(path:string,init:RequestInit={}){
 const key=getSupabasePublishableKey();
 return fetch(AEM_SUPABASE_URL+path,{...init,headers:{"apikey":key,"Authorization":`Bearer ${key}`,"Content-Type":"application/json","x-aem-client-id":getClientId(),...(init.headers||{})}});
}