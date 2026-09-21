from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
s = p.read_text()

manifest_open = r"(<manifest\b[^>]*>)"

if "<queries>" not in s:
    s = re.sub(
        manifest_open,
        r'\1\n    <queries><intent><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent></queries>',
        s,
        count=1,
    )

if "REQUEST_INSTALL_PACKAGES" not in s:
    s = re.sub(
        manifest_open,
        r'\1\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
        s,
        count=1,
    )

if "QUERY_ALL_PACKAGES" not in s:
    s = re.sub(
        manifest_open,
        r'\1\n    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />',
        s,
        count=1,
    )

if "InstallResultReceiver" not in s:
    s = s.replace(
        "</application>",
        '    <receiver android:name=".InstallResultReceiver" android:exported="false" />\n</application>',
        1,
    )

if 'android:icon="@mipmap/ic_launcher"' not in s:
    s = re.sub(r'<application\\b([^>]*?)>', r'<application\\1 android:icon="@drawable/aem_launcher">', s, count=1)

if "aem_file_paths" not in s:
    authority = "${applicationId}.fileprovider"
    s = s.replace(
        "</application>",
        '    <provider android:name="androidx.core.content.FileProvider" android:authorities="' + authority + '" android:exported="false" android:grantUriPermissions="true">\n        <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/aem_file_paths" />\n    </provider>\n</application>',
        1,
    )

p.write_text(s)


res = p.parent / "res"
(res / "drawable").mkdir(parents=True, exist_ok=True)
(res / "xml").mkdir(parents=True, exist_ok=True)
source_dir = Path(__file__).resolve().parent
for name in ("aem_launcher.xml", "aem_file_paths.xml"):
    target_dir = res / ("drawable" if name == "aem_launcher.xml" else "xml")
    (target_dir / name).write_text((source_dir / name).read_text())
