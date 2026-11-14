import { pathToFileURL } from 'url';
export function isAllowedExternal(url: string): boolean {
  try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function isTrustedRenderer(url: string, rendererFile: string, devUrl?: string): boolean {
  try {
    const u = new URL(url);
    if (devUrl) return u.origin === new URL(devUrl).origin;
    u.hash = ''; u.search = '';
    return u.href === pathToFileURL(rendererFile).href;
  } catch { return false; }
}
export function newerStableVersion(latest: string, current: string): boolean {
  const parse = (v: string) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v)?.slice(1).map(Number);
  const a = parse(latest), b = parse(current);
  if (!a || !b || [...a,...b].some(n=>!Number.isSafeInteger(n))) return false;
  for (let i=0;i<3;i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
export function validateAvdName(name: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('AVD name must contain 1–64 letters, numbers, underscores or hyphens');
  return name;
}
