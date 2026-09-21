from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
if "REQUEST_INSTALL_PACKAGES" not in s:
    s=s.replace("<manifest", '<manifest\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />', 1)
if "InstallResultReceiver" not in s:
    s=s.replace("</application>", '    <receiver android:name=".InstallResultReceiver" android:exported="false" />\n</application>', 1)
p.write_text(s)
