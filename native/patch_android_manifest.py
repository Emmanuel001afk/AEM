from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
s = p.read_text()
manifest_open = r"(<manifest\b[^>]*>)"

if "QUERY_ALL_PACKAGES" not in s:
    s = re.sub(
        manifest_open,
        r'\1\n    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />',
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

if "InstallResultReceiver" not in s:
    s = s.replace(
        "</application>",
        '    <receiver android:name=".InstallResultReceiver" android:exported="false" />\n</application>',
        1,
    )

if 'android:icon="@drawable/aem_launcher"' not in s:
    if re.search(r'android:icon="[^"]+"', s):
        s = re.sub(r'android:icon="[^"]+"', 'android:icon="@drawable/aem_launcher"', s, count=1)
    else:
        s = re.sub(
            r'<application\b([^>]*?)>',
            r'<application\1 android:icon="@drawable/aem_launcher">',
            s,
            count=1,
        )
s = re.sub(r'\s+android:roundIcon="[^"]+"', '', s, count=1)

if "aem_file_paths" not in s:
    authority = "$"+"{applicationId}.fileprovider"
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
(res / "drawable" / "aem_launcher.xml").write_text((source_dir / "aem_launcher.xml").read_text())
(res / "xml" / "aem_file_paths.xml").write_text((source_dir / "aem_file_paths.xml").read_text())
