import type {StoreApp} from "../../domain/catalog";
import {supabaseRequest} from "./client";
export async function loadSupabaseCatalog():Promise<StoreApp[]>{
 const r=await supabaseRequest("/rest/v1/applications?select=*&order=name.asc");
 if(!r.ok) throw new Error(`Supabase catalog request failed: ${r.status}`);
 const rows=await r.json();
 return rows.map((a:any)=>({id:{provider:a.provider,project:a.project},packageIdentity:a.package_identity,name:a.name,description:a.description,sourceUrl:a.source_url,iconUrl:a.icon_url,platforms:a.platforms??[],category:a.category??"Other",functionality:a.functionality??[],screenshots:a.screenshots??[],permissions:a.permissions??[]}));
}