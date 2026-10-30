#!/usr/bin/env python3
"""Build the genuine, debug-signed Android runtime probe using SDK tools, without Gradle."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--sdk', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
sdk = Path(args.sdk).resolve()
output = Path(args.output).resolve()
root = Path(__file__).resolve().parents[1]
fixture = root / 'tests/fixtures/android'
ext = '.exe' if os.name == 'nt' else ''
tools = sdk / 'build-tools/35.0.1'
jar = sdk / 'platforms/android-35/android.jar'
java_home = os.environ.get('JAVA_HOME')
java = Path(java_home) / 'bin' / ('java' + ext) if java_home else shutil.which('java')
javac = Path(java_home) / 'bin' / ('javac' + ext) if java_home else shutil.which('javac')
keytool = Path(java_home) / 'bin' / ('keytool' + ext) if java_home else shutil.which('keytool')
if not all([java, javac, keytool, jar.exists(), (tools / ('aapt2' + ext)).exists()]):
    raise SystemExit('A JDK, platforms;android-35 and build-tools;35.0.1 are required to build the test APK.')
output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='aem-probe-') as temporary:
    temp = Path(temporary)
    classes = temp / 'classes'
    dex = temp / 'dex'
    classes.mkdir(); dex.mkdir()
    unsigned = temp / 'unsigned.apk'
    aligned = temp / 'aligned.apk'
    subprocess.run([str(tools / ('aapt2' + ext)), 'link', '-I', str(jar), '--manifest', str(fixture / 'AndroidManifest.xml'), '--min-sdk-version', '26', '--target-sdk-version', '35', '--version-code', '1', '--version-name', '1.0', '-o', str(unsigned)], check=True)
    subprocess.run([str(javac), '-source', '8', '-target', '8', '-bootclasspath', str(jar), '-d', str(classes), str(fixture / 'ProbeActivity.java')], check=True)
    subprocess.run([str(java), '-cp', str(tools / 'lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', str(jar), '--min-api', '26', '--output', str(dex), *[str(p) for p in classes.rglob('*.class')]], check=True)
    with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
        archive.write(dex / 'classes.dex', 'classes.dex')
    subprocess.run([str(tools / ('zipalign' + ext)), '-f', '4', str(unsigned), str(aligned)], check=True)
    keystore = temp / 'probe.keystore'
    subprocess.run([str(keytool), '-genkeypair', '-keystore', str(keystore), '-storetype', 'JKS', '-storepass', 'android', '-keypass', 'android', '-alias', 'probe', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=AEM Runtime Test,O=AEM,C=US'], check=True)
    subprocess.run([str(java), '-jar', str(tools / 'lib/apksigner.jar'), 'sign', '--ks', str(keystore), '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--ks-key-alias', 'probe', '--out', str(output), str(aligned)], check=True)
    subprocess.run([str(java), '-jar', str(tools / 'lib/apksigner.jar'), 'verify', str(output)], check=True)
print(f'Built and verified real test APK: {output} ({output.stat().st_size} bytes)')
