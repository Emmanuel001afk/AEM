/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
import type { DesktopBridge } from "./services/emulator/contract";
declare global {
  interface Window {
    aemDesktop?: DesktopBridge;
    electron?: DesktopBridge;
    AEM_IS_DESKTOP?: boolean;
  }
}
