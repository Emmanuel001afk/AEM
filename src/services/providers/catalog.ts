import {supabaseRequest} from "../supabase/client";

export interface SourceProvider {
  id:string;
  label:string;
  active:boolean;
  config:Record<string,unknown>;
  updated_at:string;
}

export interface SourceSyncState {
  provider:string;
  status:string;
  last_started_at?:string;
  last_success_at?:string;
  last_error?:string;
  repositories_scanned:number;
  applications_discovered:number;
  releases_discovered:number;
  artifacts_discovered:number;
  updated_at:string;
}

export async function listSourceProviders():Promise<SourceProvider[]>{
  const r=await supabaseRequest("/rest/v1/source_providers?select=*&order=label.asc");
  if(!r.ok) throw new Error(`Source providers failed: ${r.status}`);
  return r.json();
}

export async function getSourceSyncState(provider="github"):Promise<SourceSyncState|undefined>{
  const r=await supabaseRequest(`/rest/v1/source_sync_state?select=*&provider=eq.${encodeURIComponent(provider)}&limit=1`);
  if(!r.ok) throw new Error(`Source sync state failed: ${r.status}`);
  const rows=await r.json();
  return rows[0];
}
