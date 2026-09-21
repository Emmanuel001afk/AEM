from pathlib import Path
import re
import sys

p=Path(sys.argv[1])
s=p.read_text()
if "<queries>" not in s:
    s=re.sub(r"(<manifest\b[^>]*>)", r'\1\n    <queries><intent><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent></queries>', s, count=1)

if "REQUEST_INSTALL_PACKAGES" not in s:
    s=re.sub(r"(<manifest\b[^>]*>)", r'\1\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />', s, count=1)
if "QUERY_ALL_PACKAGES" not in s:
    s=re.sub(r"(<manifest\\b[^>]*>)", r"\1\n    <uses-permission android:name=\"android.permission.QUERY_ALL_PACKAGES\" />", s, count=1)

if "InstallResultReceiver" not in s:
    s=s.replace("</application>", '    <receiver android:name=".InstallResultReceiver" android:exported="false" />\n</application>', 1)
p.write_text(s)
