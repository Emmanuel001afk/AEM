import type {StoreApp} from "../domain/catalog";

export interface ManagerOptions { loadCatalog:()=>Promise<StoreApp[]>; }

/** Deterministic AEM Manager. It coordinates refreshes without replacing the existing catalog/build/download systems. */
export function createManager(options:ManagerOptions){
 let refreshing=false;
 return {
  async refreshCatalog():Promise<StoreApp[]>{
   if(refreshing) return options.loadCatalog();
   refreshing=true;
   try{return await options.loadCatalog();}finally{refreshing=false;}
  },
  selectLatest(app:StoreApp,channel:"stable"|"beta"|"development"){return app.latest?.[channel]||app.latest?.stable||app.latest?.beta||app.latest?.development;}
 };
}
