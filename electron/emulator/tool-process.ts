import { spawn, type SpawnOptions } from 'child_process';
// Windows cannot execute SDK .bat files with execFile. Do not enable a shell for untrusted arguments.
export function sdkCommand(file: string, args: string[], platform = process.platform): {file:string; args:string[]} {
  if (platform !== 'win32' || !file.toLowerCase().endsWith('.bat')) return {file,args};
  for (const value of [file,...args]) if (/["%!\r\n&|<>^]/.test(value)) throw new Error('SDK batch path/argument contains unsafe command characters; choose a plain SDK/package path');
  const command = [file,...args].map(a=>`"${a}"`).join(' ');
  return {file:process.env.ComSpec || 'cmd.exe',args:['/d','/s','/c',`"${command}"`]};
}
export function spawnSdk(file: string, args: string[], options: SpawnOptions) {
  const command=sdkCommand(file,args);
  return spawn(command.file,command.args,{...options,windowsHide:true});
}
