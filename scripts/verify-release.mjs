// Structural validation complements (never replaces) apksigner and Windows smoke tests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
export function verifyPE(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) !== 64 || dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a DOS/PE executable');
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset + 26 > size) throw new Error('Invalid PE header offset');
    const pe = Buffer.alloc(26);
    fs.readSync(fd, pe, 0, pe.length, offset);
    if (!pe.subarray(0, 4).equals(Buffer.from([80,69,0,0]))) throw new Error('Missing PE signature');
    if (![0x14c, 0x8664].includes(pe.readUInt16LE(4))) throw new Error('Unexpected Windows machine architecture');
    if (!pe.readUInt16LE(6) || !(pe.readUInt16LE(22) & 2)) throw new Error('Not an executable PE image');
    if (![0x10b,0x20b].includes(pe.readUInt16LE(24))) throw new Error('Invalid PE optional header');
  } finally { fs.closeSync(fd); }
}
export async function verifyRelease(dir) {
  const files = fs.readdirSync(dir);
  const setup = files.filter(n => /^AEM-Store-[\d.]+-Setup-x64\.exe$/.test(n));
  const portable = files.filter(n => /^AEM-Store-[\d.]+-Portable-x64\.exe$/.test(n));
  if (setup.length !== 1 || portable.length !== 1) throw new Error('Exactly one Setup and one Portable executable required');
  if (setup[0].replace('-Setup-', '-') !== portable[0].replace('-Portable-', '-')) throw new Error('Windows versions differ');
  for (const n of [...setup, ...portable]) verifyPE(path.join(dir,n));
  const apk = path.join(dir,'app-release.apk');
  const fd = fs.openSync(apk,'r');
  const signature = Buffer.alloc(4);
  try { fs.readSync(fd,signature,0,4,0); } finally { fs.closeSync(fd); }
  if (!signature.equals(Buffer.from([80,75,3,4]))) throw new Error('APK is not a ZIP container (signature still needs apksigner verification)');
  const required = ['app-release.apk',...setup,...portable];
  const sums = [];
  for (const n of required) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(dir,n))) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${n}`);
  }
  fs.writeFileSync(path.join(dir,'SHA256SUMS.txt'),sums.join('\n')+'\n');
  return required;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await verifyRelease(process.argv[2] || 'release'));
}
