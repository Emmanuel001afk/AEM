import fs from 'node:fs';
const run = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isSafeInteger(run) || run < 1 || run > 65535) throw new Error('Release run number must be 1..65535; bump version scheme before overflow');
const version = `0.2.${run}`;
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version = version;
fs.writeFileSync('package.json', JSON.stringify(pkg,null,2)+'\n');
if (fs.existsSync('android/app/build.gradle')) {
  const file = 'android/app/build.gradle';
  let text = fs.readFileSync(file,'utf8');
  // Above the old 1_800_000_000 + days*1000 baseline; independent of Windows semver.
  const code = 1_810_000_000 + run;
  if (!/versionCode\s+\d+/.test(text) || !/versionName\s+"[^"]+"/.test(text)) throw new Error('Unknown Capacitor version configuration');
  text = text.replace(/versionCode\s+\d+/,`versionCode ${code}`).replace(/versionName\s+"[^"]+"/,`versionName "${version}"`);
  fs.writeFileSync(file,text);
}
console.log(`AEM release ${version}; source ${process.env.GITHUB_SHA || 'local'}`);
