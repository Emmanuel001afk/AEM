package com.aem.store;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

@CapacitorPlugin(name="AemInstaller")
public class AemInstallerPlugin extends Plugin {
    private static final int INSTALL_RESULT = 7412;

    @PluginMethod
    public void getInstallCapability(PluginCall call) {
        JSObject out = new JSObject();
        out.put("canRequestPackageInstalls", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        out.put("api", Build.VERSION.SDK_INT);
        call.resolve(out);
    }

    @PluginMethod
    public void openInstallPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            getContext().startActivity(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final String filename = call.getString("filename", "aem-download.apk");
        final String mode = call.getString("mode", "split");
        if (url == null || url.isEmpty()) { call.reject("Download URL is required"); return; }

        getActivity().runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                JSObject out = new JSObject();
                out.put("permissionRequired", true);
                call.resolve(out);
                return;
            }
            new Thread(() -> {
                try {
                    File downloaded = download(url, filename);
                    install(downloaded, mode);
                    JSObject out = new JSObject();
                    out.put("started", true);
                    out.put("file", downloaded.getAbsolutePath());
                    call.resolve(out);
                } catch (Exception e) {
                    call.reject(e.getMessage() == null ? "Installation failed" : e.getMessage(), e);
                }
            }, "aem-installer").start();
        });
    }

    private File download(String source, String filename) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(source).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(30000);
        c.setReadTimeout(120000);
        c.setRequestProperty("User-Agent", "AEM Store");
        c.connect();
        if (c.getResponseCode() < 200 || c.getResponseCode() >= 300) throw new IOException("Download failed: HTTP " + c.getResponseCode());
        File dir = new File(getContext().getCacheDir(), "aem-downloads");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cannot create download directory");
        File out = new File(dir, filename.replaceAll("[^A-Za-z0-9._-]", "_"));
        try (InputStream in = new BufferedInputStream(c.getInputStream()); OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
            byte[] buf = new byte[1024 * 64]; int n;
            while ((n = in.read(buf)) >= 0) os.write(buf, 0, n);
        } finally { c.disconnect(); }
        return out;
    }

    private void install(File file, String mode) throws Exception {
        List<File> apks = new ArrayList<>();
        String lower = file.getName().toLowerCase(Locale.US);
        if (lower.endsWith(".apk")) {
            apks.add(file);
        } else if (lower.endsWith(".apks") || lower.endsWith(".xapk") || lower.endsWith(".apkm") || lower.endsWith(".zip")) {
            File dir = new File(file.getParentFile(), "parts-" + System.nanoTime());
            if (!dir.mkdirs()) throw new IOException("Cannot create split staging directory");
            try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(file)))) {
                ZipEntry e;
                byte[] buf = new byte[1024 * 64];
                while ((e = zin.getNextEntry()) != null) {
                    if (e.isDirectory() || !e.getName().toLowerCase(Locale.US).endsWith(".apk")) continue;
                    String safe = new File(e.getName()).getName();
                    File target = new File(dir, safe);
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(target))) {
                        int n; while ((n = zin.read(buf)) >= 0) os.write(buf, 0, n);
                    }
                    apks.add(target);
                }
            }
            if (apks.isEmpty()) throw new IOException("No APK parts found in archive");
        } else {
            throw new IOException("Unsupported installer file: " + file.getName());
        }

        PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        long total = 0;
        for (File apk : apks) total += apk.length();
        params.setSize(total);
        if (Build.VERSION.SDK_INT >= 33) params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE);
        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            int i = 0;
            for (File apk : apks) {
                String name = "apk-" + (i++) + "-" + apk.getName();
                try (InputStream in = new BufferedInputStream(new FileInputStream(apk));
                     OutputStream out = session.openWrite(name, 0, apk.length())) {
                    byte[] buf = new byte[1024 * 64]; int n;
                    while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
                    session.fsync(out);
                }
            }
            Intent status = new Intent(getContext(), InstallResultReceiver.class);
            status.setPackage(getContext().getPackageName());
            PendingIntent pi = PendingIntent.getBroadcast(getContext(), INSTALL_RESULT, status,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            session.commit(pi.getIntentSender());
        } finally {
            session.close();
        }
    }
}
