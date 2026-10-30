import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";

// Development-only loopback server. Packaged AEM never loads a dev server or remote renderer.
const server = await createServer({ configFile: "vite.desktop.config.ts", server: { host: "127.0.0.1", port: 5173, strictPort: true } });
await server.listen();
const child = spawn(electron, ["."], { stdio: "inherit", env: { ...process.env, AEM_DEV_SERVER: "http://127.0.0.1:5173" } });
let closing = false;
async function close(code = 0) { if (closing) return; closing = true; child.kill(); await server.close(); process.exitCode = code; }
child.on("exit", (code) => void close(code || 0));
child.on("error", (error) => { console.error(error); void close(1); });
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
