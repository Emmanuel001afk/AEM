package com.aem.store;

import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.content.pm.PackageInstaller;
import java.io.BufferedInputStream;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AemInstallerPlugin.class);
        registerPlugin(AemTransferPlugin.class);
        super.onCreate(savedInstanceState);
        handleIncomingApk(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingApk(intent);
    }

    private void handleIncomingApk(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        if (!"application/vnd.android.package-archive".equals(intent.getType())) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            return;
        }
        Uri uri = intent.getData();
        try {
            PackageInstaller installer = getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            if (Build.VERSION.SDK_INT >= 29) params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_OTHER);
            int id = installer.createSession(params);
            PackageInstaller.Session session = installer.openSession(id);
            try {
                java.io.InputStream raw = getContentResolver().openInputStream(uri);
                if (raw == null) throw new java.io.IOException("Unable to read APK");
                try (BufferedInputStream in = new BufferedInputStream(raw);
                     java.io.OutputStream out = session.openWrite("base.apk", 0, -1)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) >= 0) if (n > 0) out.write(buf, 0, n);
                    session.fsync(out);
                }
                Intent result = new Intent(this, InstallResultReceiver.class);
                result.setAction("com.aem.store.EXTERNAL_INSTALL");
                android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(
                    this, id, result,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_MUTABLE);
                session.commit(pi.getIntentSender());
            } finally {
                session.close();
            }
        } catch (Exception e) {
            android.util.Log.e("AEM_INSTALL", "External APK install failed", e);
        }
    }
}
