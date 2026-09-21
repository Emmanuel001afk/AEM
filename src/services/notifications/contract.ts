export type NotificationKind="update"|"download"|"release"|"security"|"system";
export interface AemNotification{id:string;kind:NotificationKind;title:string;body:string;createdAt:string;read:boolean;action?:{type:"app"|"release"|"download";id:string};}
export interface NotificationService{notify(notification:Omit<AemNotification,"id"|"createdAt"|"read">):Promise<void>;listUnread():Promise<AemNotification[]>;markRead(id:string):Promise<void>;}
