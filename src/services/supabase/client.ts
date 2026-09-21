export const AEM_SUPABASE_URL="https://wfvvmyixqcwosmuldxoq.supabase.co";
export function getSupabasePublishableKey(){return import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string|undefined;}
export async function supabaseRequest(path:string,init:RequestInit={}){const key=getSupabasePublishableKey();if(!key)throw new Error("AEM Supabase publishable key is not configured");return fetch(AEM_SUPABASE_URL+path,{...init,headers:{"apikey":key,"Authorization":`Bearer ${key}`,"Content-Type":"application/json",...(init.headers||{})}});}
