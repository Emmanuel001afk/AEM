import type {InstalledApplication} from "../../domain/model";
export interface InstallerAdapter{listInstalledApplications():Promise<InstalledApplication[]>;install(artifactUrl:string):Promise<void>;open(packageIdentity:string):Promise<void>}
// Package identity, signing identity, and version comparison are security boundaries and must not be delegated to AI.
