package com.aem.store;

import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.content.pm.PackageInstaller;
import android.database.Cursor;
import android.provider.OpenableColumns;
import java.io.*;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AemInstallerPlugin.class);
        registerPlugin(AemTransferPlugin.class);
        super.onCreate(savedInstanceState);
        handleIncomingPackage(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingPackage(intent);
    }

    private void handleIncomingPackage(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        Uri uri = intent.getData();
        String name = displayName(uri);
        String type = intent.getType() == null ? "" : intent.getType().toLowerCase(Locale.US);
        if (!isSupportedPackage(name, type)) return;

        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())));
            return;
        }

        try {
            List<File> apks = materializePackage(uri, name, type);
            installApks(apks, name);
        } catch (Exception e) {
            android.util.Log.e("AEM_INSTALL", "External package install failed", e);
        }
    }

    private boolean isSupportedPackage(String name, String type) {
        String lower = name == null ? "" : name.toLowerCase(Locale.US);
        return lower.endsWith(".apk") || lower.endsWith(".apks") || lower.endsWith(".xapk")
                || lower.endsWith(".apkm") || lower.endsWith(".zip")
                || "application/vnd.android.package-archive".equals(type)
                || "application/zip".equals(type)
                || "application/octet-stream".equals(type);
    }

    private String displayName(Uri uri) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        String p = uri.getLastPathSegment();
        return p == null ? "aem-package" : p;
    }

    private List<File> materializePackage(Uri uri, String name, String type) throws Exception {
        String lower = name.toLowerCase(Locale.US);
        File dir = new File(getCacheDir(), "incoming-packages-" + System.nanoTime());
        if (!dir.mkdirs()) throw new IOException("Cannot create package staging directory");

        if (lower.endsWith(".apk") || "application/vnd.android.package-archive".equals(type)) {
            File apk = new File(dir, "base.apk");
            copyUri(uri, apk);
            return Collections.singletonList(apk);
        }

        File archive = new File(dir, "package.zip");
        copyUri(uri, archive);
        ArrayList<File> apks = new ArrayList<>();
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(archive)))) {
            ZipEntry entry;
            byte[] buffer = new byte[65536];
            while ((entry = zin.getNextEntry()) != null) {
                if (entry.isDirectory() || !entry.getName().toLowerCase(Locale.US).endsWith(".apk")) continue;
                String safe = new File(entry.getName()).getName();
                if (safe.isEmpty()) continue;
                File out = new File(dir, "apk-" + apks.size() + "-" + safe);
                try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
                    int n;
                    while ((n = zin.read(buffer)) >= 0) if (n > 0) os.write(buffer, 0, n);
                }
                if (out.length() > 0) apks.add(out);
            }
        }
        if (apks.isEmpty()) throw new IOException("No APK files were found inside " + name);
        return apks;
    }

    private void copyUri(Uri uri, File target) throws Exception {
        InputStream raw = getContentResolver().openInputStream(uri);
        if (raw == null) throw new IOException("Unable to read selected package");
        try (InputStream in = new BufferedInputStream(raw);
             OutputStream out = new BufferedOutputStream(new FileOutputStream(target))) {
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) >= 0) if (n > 0) out.write(buffer, 0, n);
        }
    }

    private void installApks(List<File> apks, String sourceName) throws Exception {
        PackageInstaller installer = getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        long total = 0;
        for (File apk : apks) total += apk.length();
        if (total > 0) params.setSize(total);

        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            int index = 0;
            for (File apk : apks) {
                try (InputStream in = new BufferedInputStream(new FileInputStream(apk));
                     OutputStream out = session.openWrite("apk-" + (index++) + "-" + apk.getName(), 0, apk.length())) {
                    byte[] buffer = new byte[65536];
                    int n;
                    while ((n = in.read(buffer)) >= 0) if (n > 0) out.write(buffer, 0, n);
                    session.fsync(out);
                }
            }
            Intent status = new Intent(this, InstallConfirmationActivity.class);
            status.setAction("com.aem.store.INSTALL_STATUS");
            status.putExtra("aem_download_path", sourceName);
            android.app.PendingIntent pi = android.app.PendingIntent.getActivity(
                    this, 9000 + (id % 100000), status,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_MUTABLE);
            session.commit(pi.getIntentSender());
        } finally {
            session.close();
        }
    }
}
