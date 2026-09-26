import type {Application,Release,ReleaseChannel,Platform} from "./model";
export interface StoreApp extends Application { category:string; featured?:boolean; functionality:string[]; screenshots:string[]; permissions:string[]; latest?: Release; }
export interface CatalogFilter { query?:string; category?:string; platform?:Platform; channel?:ReleaseChannel; }
export function filterCatalog(apps:StoreApp[], filter:CatalogFilter){const q=filter.query?.trim().toLowerCase();return apps.filter(a=>(!q||[a.name,a.description,a.category,...a.functionality].join(" ").toLowerCase().includes(q))&&(!filter.category||a.category===filter.category)&&(!filter.platform||a.platforms.includes(filter.platform)));}
