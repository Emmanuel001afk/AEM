const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
module.exports = async function verifyArtifact(context) {
  if (!context.file.endsWith(".exe")) return;
  const stat = fs.statSync(context.file);
  if (stat.size < 40 * 1024 * 1024) throw new Error(`Refusing suspiciously small Windows artifact: ${stat.size} bytes`);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(context.file)).digest("hex");
  const report = { file: path.basename(context.file), bytes: stat.size, sha256: hash, createdAt: new Date().toISOString() };
  fs.writeFileSync(context.file + ".verification.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`Verified Windows artifact size and SHA-256: ${JSON.stringify(report)}`);
};
