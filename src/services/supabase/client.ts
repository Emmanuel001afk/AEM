export const AEM_SUPABASE_URL="https://wfvvmyixqcwosmuldxoq.supabase.co";
const DEFAULT_PUBLISHABLE_KEY="sb_publishable_Imgtr_W_Z868cBsNEcWpeg_89FE2Mvb";
export function getSupabasePublishableKey(){return import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||DEFAULT_PUBLISHABLE_KEY;}
export async function supabaseRequest(path:string,init:RequestInit={}){
 const key=getSupabasePublishableKey();
 return fetch(AEM_SUPABASE_URL+path,{...init,headers:{"apikey":key,"Authorization":`Bearer ${key}`,"Content-Type":"application/json",...(init.headers||{})}});
}