import fs from "fs";
import path from "path";
const src = "electron";
const out = "dist-electron";
if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
console.log(`Electron main compiled to ${out}/main.js`);
