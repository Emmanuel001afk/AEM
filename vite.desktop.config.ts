import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web and Capacitor entry points and their build configurations are untouched.
export default defineConfig({
  plugins: [react(), {
    name: "aem-desktop-csp",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'">`);
    },
  }],
  base: "./",
  build: { outDir: "desktop-dist", emptyOutDir: true, sourcemap: false },
});
