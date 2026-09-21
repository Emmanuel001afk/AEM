import type {Artifact,Application,Release} from "../../domain/model";
export interface CatalogStore{saveApplication(application:Application):Promise<void>;saveRelease(release:Release):Promise<void>;listApplications():Promise<Application[]>;listReleases(applicationId:Application["id"]):Promise<Release[]>}
export interface ArtifactStorage{put(source:{url:string;sha256?:string},destinationKey:string):Promise<string>;getDownloadUrl(key:string):Promise<string>}
