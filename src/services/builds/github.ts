const AEM_CLIENT_ID_KEY="aem-client-id";
function clientId(){let id=localStorage.getItem(AEM_CLIENT_ID_KEY);if(!id){id=crypto.randomUUID();localStorage.setItem(AEM_CLIENT_ID_KEY,id)}return id}
import {supabaseRequest} from "../supabase/client";

export type BuildRequestInput={
 repository:string;
 ref?:string;
 module?:string;
 variant?:string;
 channel?: "stable"|"beta"|"development";
};

export async function requestGithubBuild(input:BuildRequestInput){
 const repository=input.repository.trim().replace(/^https?:\/\/github\.com\//,"").replace(/\.git$/,"").replace(/\/$/,"");
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Enter a GitHub repository as owner/name.");
 const r=await supabaseRequest("/rest/v1/build_requests",{
  method:"POST",
  headers:{Prefer:"return=representation"},
  body:JSON.stringify({repository,ref:input.ref?.trim()||"main",module:input.module?.trim()||null,variant:input.variant?.trim()||"debug",channel:input.channel||"development",client_id:clientId()})
 });
 if(!r.ok) throw new Error(`Build request failed: ${r.status}`);
 return (await r.json())[0];
}

export async function listBuildRequests(){
 const r=await supabaseRequest("`/rest/v1/build_requests?select=*&client_id=eq.${clientId()}&order=created_at.desc&limit=20`");
 if(!r.ok) throw new Error(`Build queue failed: ${r.status}`);
 return r.json();
}
