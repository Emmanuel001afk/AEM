import type {InstalledApplication,Release} from "../../domain/model";
import {compareAndroidRelease} from "../../domain/version";
export function getInstallAction(release:Release,installed:InstalledApplication|undefined){if(!installed)return"INSTALL" as const;const state=compareAndroidRelease(release,installed);if(state==="update-available")return"UPDATE" as const;if(state==="installed")return"OPEN" as const;if(state==="local-newer")return"CURRENT" as const;return"INCOMPATIBLE" as const;}
