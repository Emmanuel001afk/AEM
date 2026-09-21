export type Platform="android"|"windows"|"linux"|"macos"|"web";
export type ArtifactKind="apk"|"apks"|"xapk"|"apkm"|"aab"|"exe"|"msix"|"appimage"|"deb"|"rpm"|"dmg"|"pkg"|"url"|"other";
export type ReleaseChannel="stable"|"beta"|"development"; export type ReleaseStatus="draft"|"published"|"withdrawn";
export interface ApplicationId{provider:string;project:string}
export interface Application{databaseId?:number;id:ApplicationId;packageIdentity?:string;name:string;description?:string;sourceUrl?:string;iconUrl?:string;platforms:Platform[]}
export interface Version{name:string;code?:number}
export interface Artifact{id:string;platform:Platform;kind:ArtifactKind;filename:string;downloadUrl:string;sizeBytes?:number;sha256?:string;packageIdentity?:string;signingCertificateSha256?:string;versionCode?:number}
export interface Release{id:string;applicationId:ApplicationId;version:Version;channel:ReleaseChannel;status:ReleaseStatus;title?:string;notes?:string;publishedAt?:string;sourceReleaseId:string;artifacts:Artifact[]}
export type InstallState="not-installed"|"installed"|"update-available"|"local-newer"|"identity-mismatch";
export interface InstalledApplication{packageIdentity:string;versionName:string;versionCode:number;signingCertificateSha256?:string;installSource?:string}
export interface InstallDecision{state:InstallState;action:"INSTALL"|"OPEN"|"UPDATE"|"CURRENT"|"INCOMPATIBLE";reason:string}
export interface ReleaseEvent{provider:string;eventType:"release"|"workflow_run"|"repository_dispatch";sourceProject:string;sourceReleaseId:string;occurredAt:string;payload:unknown}
