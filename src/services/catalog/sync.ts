import {supabaseRequest} from "../supabase/client";

export async function syncGithubCatalog():Promise<{ok:boolean;scanned?:number;discovered?:number;releases?:number;artifacts?:number;queued?:number}>{
  const r=await supabaseRequest("/functions/v1/aem-sync-github",{method:"POST",body:JSON.stringify({owner:"Emmanuel001afk"})});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data?.error||`GitHub catalog sync failed: ${r.status}`);
  return data;
}
