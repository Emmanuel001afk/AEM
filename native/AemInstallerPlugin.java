package com.aem.store;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

@CapacitorPlugin(name="AemInstaller")
public class AemInstallerPlugin extends Plugin {
    private static final int INSTALL_RESULT = 7412;

    @PluginMethod
    public void getInstalledVersions(PluginCall call) {
        JSArray apps = new JSArray();
        for (android.content.pm.PackageInfo p : getContext().getPackageManager().getInstalledPackages(0)) {
            JSObject item = new JSObject();
            item.put("packageName", p.packageName);
            item.put("versionName", p.versionName == null ? "" : p.versionName);
            item.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            apps.put(item);
        }
        JSObject out = new JSObject();
        out.put("apps", apps);
        call.resolve(out);
    }

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
        final String expectedSha256 = call.getString("sha256", "");
        final String expectedPackage = call.getString("packageIdentity", "");

        if (url == null || url.isEmpty()) {
            call.reject("Download URL is required");
            return;
        }

        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject out = new JSObject();
            out.put("permissionRequired", true);
            call.resolve(out);
            return;
        }

        new Thread(() -> {
            try {
                File downloaded = download(url, filename, expectedSha256);
                install(downloaded, mode, expectedPackage);
                JSObject out = new JSObject();
                out.put("started", true);
                out.put("file", downloaded.getAbsolutePath());
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Installation failed" : e.getMessage(), e);
            }
        }, "aem-installer").start();
    }

    private File download(String source, String filename, String expectedSha256) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(source).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(30000);
        c.setReadTimeout(120000);
        c.setRequestProperty("User-Agent", "AEM Store");
        c.connect();

        int status = c.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IOException("Download failed: HTTP " + status);
        }

        File dir = new File(getContext().getCacheDir(), "aem-downloads");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cannot create download directory");

        File out = new File(dir, filename.replaceAll("[^A-Za-z0-9._-]", "_"));
        try (InputStream in = new BufferedInputStream(c.getInputStream());
             OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
            byte[] buf = new byte[1024 * 64];
            int n;
            while ((n = in.read(buf)) >= 0) os.write(buf, 0, n);
        } finally {
            c.disconnect();
        }

        if (expectedSha256 != null && !expectedSha256.isEmpty()) {
            String actual = sha256(out);
            if (!actual.equalsIgnoreCase(expectedSha256)) {
                if (!out.delete()) out.deleteOnExit();
                throw new IOException("Package integrity check failed");
            }
        }
        return out;
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buf = new byte[1024 * 64];
            int n;
            while ((n = in.read(buf)) >= 0) digest.update(buf, 0, n);
        }
        StringBuilder out = new StringBuilder();
        for (byte b : digest.digest()) out.append(String.format(Locale.US, "%02x", b));
        return out.toString();
    }

    private void install(File file, String mode, String expectedPackage) throws Exception {
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
                        int n;
                        while ((n = zin.read(buf)) >= 0) os.write(buf, 0, n);
                    }
                    apks.add(target);
                }
            }
            if (apks.isEmpty()) throw new IOException("No APK parts found in archive");
        } else {
            throw new IOException("Unsupported installer file: " + file.getName());
        }

        PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);

        long total = 0;
        for (File apk : apks) total += apk.length();
        params.setSize(total);

        if (Build.VERSION.SDK_INT >= 21 && expectedPackage != null && !expectedPackage.isEmpty()) {
            params.setAppPackageName(expectedPackage);
        }
        if (Build.VERSION.SDK_INT >= 31) {
            params.setInstallScenario(android.content.pm.PackageManager.INSTALL_SCENARIO_FAST);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_STORE);
        }

        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            int i = 0;
            for (File apk : apks) {
                String name = "apk-" + (i++) + "-" + apk.getName();
                try (InputStream in = new BufferedInputStream(new FileInputStream(apk));
                     OutputStream out = session.openWrite(name, 0, apk.length())) {
                    byte[] buf = new byte[1024 * 64];
                    int n;
                    while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
                    session.fsync(out);
                }
            }

            Intent status = new Intent(getContext(), InstallResultReceiver.class);
            status.setPackage(getContext().getPackageName());
            status.putExtra("aem_download_path", file.getAbsolutePath());

            PendingIntent pi = PendingIntent.getBroadcast(
                    getContext(),
                    INSTALL_RESULT,
                    status,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
            );
            session.commit(pi.getIntentSender());
        } finally {
            session.close();
        }
    }
}
