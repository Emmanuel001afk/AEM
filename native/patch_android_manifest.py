from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
s = p.read_text()
manifest_open = r"(<manifest\b[^>]*>)"

if "INTERNET" not in s:
    s = re.sub(
        manifest_open,
        r'\1\n    <uses-permission android:name="android.permission.INTERNET" />',
        s,
        count=1,
    )

if "READ_MEDIA_VIDEO" not in s:
    s = re.sub(
        manifest_open,
        r'\1\n    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />\n    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />\n    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
        s,
        count=1,
    )

if "NEARBY_WIFI_DEVICES" not in s:
    s = re.sub(
        manifest_open,
        r'\1\n    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />\n    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />\n    <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" />\n    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="32" />',
        s,
        count=1,
    )


if "AEM APK Installer" not in s:
    s = re.sub(
        r'(<activity[^>]*android:name="\\.MainActivity"[^>]*>.*?</activity>)',
        r'\1\n            <intent-filter android:label="AEM APK Installer">\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:mimeType="application/vnd.android.package-archive" />\n                <data android:mimeType="application/zip" />\n                <data android:mimeType="application/octet-stream" />\n            </intent-filter>',
        s,
        count=1,
        flags=re.DOTALL,
    )

if "AemTransferActivity" not in s:
    s = s.replace(
        "</application>",
        '    <activity android:name=".AemTransferActivity" android:exported="false" />\n</application>',
        1,
    )

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

if "InstallConfirmationActivity" not in s:
    s = s.replace(
        "</application>",
        '    <activity android:name=".InstallConfirmationActivity" android:exported="false" android:theme="@android:style/Theme.Translucent.NoTitleBar" />\n</application>',
        1,
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
