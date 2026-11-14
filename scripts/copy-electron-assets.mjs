import fs from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve("dist-electron");
fs.mkdirSync(outputDirectory, { recursive: true });

// package.json at the repository root declares ESM for Vite. The Electron
// main/preload files are compiled as CommonJS, so put a nearer package
// boundary next to them to make Node/Electron load them with the correct
// module format in both unpackaged and packaged builds.
const moduleMarker = path.join(outputDirectory, "package.json");
fs.writeFileSync(
  moduleMarker,
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
  "utf8",
);

console.log(`Electron main compiled to ${outputDirectory}/main.js`);
console.log(`Wrote CommonJS module marker to ${moduleMarker}`);

// Browser companion is served locally by the HTTPS transfer server, never from a CDN.
const {buildSync}=await import('esbuild');
const web=path.join(outputDirectory,'transfer','web');fs.mkdirSync(web,{recursive:true});
for(const name of ['index.html','style.css'])fs.copyFileSync(path.join('electron','transfer','web',name),path.join(web,name));
buildSync({entryPoints:['electron/transfer/web/client.js'],bundle:true,format:'iife',minify:true,outfile:path.join(web,'client.js')});
