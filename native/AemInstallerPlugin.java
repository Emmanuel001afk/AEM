package com.aem.store;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.provider.Settings;
import android.content.ActivityNotFoundException;
import androidx.core.content.FileProvider;
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
    private android.content.BroadcastReceiver installReceiver;

    @Override public void load() {
        super.load();
        installReceiver = new android.content.BroadcastReceiver() {
            @Override public void onReceive(android.content.Context context, android.content.Intent intent) {
                JSObject out = new JSObject();
                out.put("downloadId", intent.getStringExtra("aem_download_id"));
                int status = intent.getIntExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, android.content.pm.PackageInstaller.STATUS_FAILURE);
                out.put("success", status == android.content.pm.PackageInstaller.STATUS_SUCCESS);
                out.put("status", status);
                out.put("message", intent.getStringExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE));
                notifyListeners("installResult", out);
            }
        };
        android.content.IntentFilter filter = new android.content.IntentFilter("com.aem.store.INSTALL_RESULT");
        if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(installReceiver, filter, android.content.Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(installReceiver, filter);
    }

    @Override protected void handleOnDestroy() {
        if (installReceiver != null) {
            try { getContext().unregisterReceiver(installReceiver); } catch (Exception ignored) {}
            installReceiver = null;
        }
        super.handleOnDestroy();
    }

    private final java.util.concurrent.ConcurrentHashMap<String, HttpURLConnection> activeDownloads = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Set<String> cancelledDownloads = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final java.util.Set<String> pausedDownloads = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final java.util.concurrent.ConcurrentHashMap<String, DownloadSpec> downloadSpecs = new java.util.concurrent.ConcurrentHashMap<>();

    private static final class DownloadSpec {
        final String url, filename, mode, sha256, packageIdentity, signingCert, downloadId;
        final long versionCode;
        final boolean wifiOnly;
        DownloadSpec(String url, String filename, String mode, String sha256, String packageIdentity, String signingCert, long versionCode, String downloadId, boolean wifiOnly) {
            this.url=url; this.filename=filename; this.mode=mode; this.sha256=sha256; this.packageIdentity=packageIdentity; this.signingCert=signingCert;
            this.versionCode=versionCode; this.downloadId=downloadId; this.wifiOnly=wifiOnly;
        }
    }
    private static final class DownloadPausedException extends IOException {
        DownloadPausedException() { super("Download paused"); }
    }

    @PluginMethod
    public void getInstalledVersions(PluginCall call) {
        JSArray apps = new JSArray();
        try {
            JSArray requested = call.getArray("packages");
            if (requested != null && requested.length() > 0) {
                for (int i = 0; i < requested.length(); i++) {
                    String packageName = requested.getString(i);
                    addInstalled(apps, packageName);
                }
            } else {
                android.content.pm.PackageManager pm = getContext().getPackageManager();
                List<android.content.pm.PackageInfo> installedPackages;
                if (Build.VERSION.SDK_INT >= 33) {
                    installedPackages = pm.getInstalledPackages(android.content.pm.PackageManager.PackageInfoFlags.of(0));
                } else {
                    installedPackages = pm.getInstalledPackages(0);
                }
                for (android.content.pm.PackageInfo p : installedPackages) {
                    JSObject item = new JSObject();
                    item.put("packageName", p.packageName);
                    item.put("versionName", p.versionName == null ? "" : p.versionName);
                    item.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
                    item.put("signingCertificateSha256", signingCertificateSha256(p));
                    apps.put(item);
                }
            }
        } catch (Exception ignored) {}
        JSObject out = new JSObject();
        out.put("apps", apps);
        call.resolve(out);
    }

    private void addInstalled(JSArray apps, String packageName) {
        try {
            android.content.pm.PackageInfo p = getContext().getPackageManager().getPackageInfo(packageName, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES);
            JSObject item = new JSObject();
            item.put("packageName", p.packageName);
            item.put("versionName", p.versionName == null ? "" : p.versionName);
            item.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            item.put("signingCertificateSha256", signingCertificateSha256(p));
            apps.put(item);
        } catch (Exception ignored) {}
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
    public void openInstalled(PluginCall call) {
        String packageName = call.getString("packageName", "");
        if (packageName.isEmpty()) { call.reject("Package name is required"); return; }
        try {
            Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(packageName);
            if (launch == null) { call.reject("Installed application has no launch activity"); return; }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(launch);
            JSObject out = new JSObject();
            out.put("started", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Unable to open application" : e.getMessage(), e);
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final String filename = call.getString("filename", "aem-download.apk");
        final String mode = call.getString("mode", "split");
        final String expectedSha256 = call.getString("sha256", "");
        final String expectedPackage = call.getString("packageIdentity", "");
        final String expectedSigningCert = call.getString("signingCertificateSha256", "");
        final long requestedVersionCode = call.getLong("versionCode", -1L);
        final long expectedVersionCode = requestedVersionCode > 0 ? requestedVersionCode : -1L;
        final String downloadId = call.getString("downloadId", "");
        final boolean wifiOnly = call.getBoolean("wifiOnly", false);

        if (url == null || url.isEmpty()) { call.reject("Download URL is required"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject out = new JSObject(); out.put("permissionRequired", true); call.resolve(out); return;
        }

        DownloadSpec spec = new DownloadSpec(url, filename, mode, expectedSha256, expectedPackage, expectedSigningCert, expectedVersionCode, downloadId, wifiOnly);
        if (!downloadId.isEmpty()) downloadSpecs.put(downloadId, spec);
        startDownloadAndInstall(spec, call);
    }

    private void startDownloadAndInstall(final DownloadSpec spec, final PluginCall call) {
        new Thread(() -> {
            try {
                pausedDownloads.remove(spec.downloadId);
                ensureInstalledCompatibility(spec.packageIdentity, spec.signingCert, spec.versionCode);
                File downloaded = download(spec.url, spec.filename, spec.sha256, spec.downloadId, spec.wifiOnly);
                install(downloaded, spec.mode, spec.packageIdentity, spec.signingCert, spec.versionCode, spec.downloadId);
                JSObject out = new JSObject();
                out.put("started", true);
                out.put("file", downloaded.getAbsolutePath());
                call.resolve(out);
            } catch (DownloadPausedException e) {
                JSObject out = new JSObject(); out.put("paused", true); out.put("downloadId", spec.downloadId); call.resolve(out);
            } catch (Exception e) {
                if (pausedDownloads.contains(spec.downloadId)) {
                    JSObject out = new JSObject(); out.put("paused", true); out.put("downloadId", spec.downloadId); call.resolve(out); return;
                }
                if (cancelledDownloads.contains(spec.downloadId)) {
                    JSObject out = new JSObject(); out.put("cancelled", true); out.put("downloadId", spec.downloadId); call.resolve(out); return;
                }
                call.reject(e.getMessage() == null ? "Installation failed" : e.getMessage(), e);
            }
        }, "aem-installer").start();
    }

    @PluginMethod
    public void pauseDownload(PluginCall call) {
        String id = call.getString("downloadId", "");
        if (id.isEmpty()) { call.reject("Download ID is required"); return; }
        pausedDownloads.add(id);
        HttpURLConnection connection = activeDownloads.remove(id);
        if (connection != null) connection.disconnect();
        JSObject out = new JSObject(); out.put("paused", true); call.resolve(out);
    }

    @PluginMethod
    public void resumeDownload(PluginCall call) {
        String id = call.getString("downloadId", "");
        DownloadSpec spec = downloadSpecs.get(id);
        if (spec == null) { call.reject("No resumable download session found"); return; }
        pausedDownloads.remove(id);
        startDownloadAndInstall(spec, call);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String id = call.getString("downloadId", "");
        cancelledDownloads.add(id);
        pausedDownloads.remove(id);
        HttpURLConnection connection = activeDownloads.remove(id);
        if (connection != null) connection.disconnect();
        DownloadSpec spec = downloadSpecs.remove(id);
        if (spec != null) {
            File dir = new File(getContext().getCacheDir(), "aem-downloads");
            File partial = new File(dir, spec.filename.replaceAll("[^A-Za-z0-9._-]", "_") + "." + spec.downloadId.replaceAll("[^A-Za-z0-9._-]", "_") + ".part");
            if (partial.exists()) partial.delete();
        }
        JSObject out = new JSObject(); out.put("cancelled", true); call.resolve(out);
    }

    private File download(String source, String filename, String expectedSha256, String downloadId, boolean wifiOnly) throws Exception {
        if (wifiOnly && !isWifiConnected()) throw new IOException("Network unavailable: Wi-Fi-only downloads are enabled.");
        File dir = new File(getContext().getCacheDir(), "aem-downloads");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cannot create download directory");
        File partial = new File(dir, filename.replaceAll("[^A-Za-z0-9._-]", "_") + "." + downloadId.replaceAll("[^A-Za-z0-9._-]", "_") + ".part");
        long existing = partial.exists() ? partial.length() : 0L;

        HttpURLConnection c = (HttpURLConnection) new URL(source).openConnection();
        if (downloadId != null && !downloadId.isEmpty()) activeDownloads.put(downloadId, c);
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(30000);
        c.setReadTimeout(120000);
        c.setRequestProperty("User-Agent", "AEM Store");
        if (existing > 0) c.setRequestProperty("Range", "bytes=" + existing + "-");
        c.connect();
        int status = c.getResponseCode();
        if (status < 200 || status >= 300) {
            activeDownloads.remove(downloadId);
            c.disconnect();
            throw new IOException("Network error: HTTP " + status);
        }

        boolean append = existing > 0 && status == HttpURLConnection.HTTP_PARTIAL;
        if (!append) existing = 0L;
        long total = c.getContentLengthLong();
        if (total > 0 && append) total += existing;
        long done = existing, lastEmit = 0;
        try (InputStream in = new BufferedInputStream(c.getInputStream());
             OutputStream os = new BufferedOutputStream(new FileOutputStream(partial, append))) {
            byte[] buf = new byte[1024 * 64];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n == 0) continue;
                if (cancelledDownloads.contains(downloadId)) throw new IOException("Download cancelled");
                if (pausedDownloads.contains(downloadId)) throw new DownloadPausedException();
                os.write(buf, 0, n);
                done += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit >= 250 || (total > 0 && done >= total)) {
                    JSObject progress = new JSObject();
                    progress.put("downloadId", downloadId);
                    progress.put("bytesDownloaded", done);
                    progress.put("totalBytes", total);
                    notifyListeners("downloadProgress", progress);
                    lastEmit = now;
                }
            }
        } finally {
            activeDownloads.remove(downloadId);
            c.disconnect();
        }
        if (cancelledDownloads.contains(downloadId)) throw new IOException("Download cancelled");
        if (pausedDownloads.contains(downloadId)) throw new DownloadPausedException();

        File out = new File(dir, filename.replaceAll("[^A-Za-z0-9._-]", "_"));
        if (out.exists()) out.delete();
        if (!partial.renameTo(out)) throw new IOException("Unable to finalize downloaded package");
        if (expectedSha256 != null && !expectedSha256.isEmpty()) {
            String actual = sha256(out);
            if (!actual.equalsIgnoreCase(expectedSha256)) {
                if (!out.delete()) out.deleteOnExit();
                throw new IOException("Package integrity check failed");
            }
        }
        return out;
    }

    private boolean isWifiConnected() {
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network n = cm.getActiveNetwork();
        if (n == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(n);
        return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
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

    private void install(File file, String mode, String expectedPackage, String expectedSigningCert, long expectedVersionCode, String expectedDownloadId) throws Exception {
        validatePackage(file, expectedPackage, expectedSigningCert, expectedVersionCode);
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
        } else throw new IOException("Unsupported installer file: " + file.getName());

        if ("system".equalsIgnoreCase(mode)) {
            if (!lower.endsWith(".apk")) throw new IOException("Android system installer mode supports .apk only; use AEM Split Installer for split-package archives.");
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { getContext().startActivity(intent); }
            catch (ActivityNotFoundException e) { throw new IOException("No Android package installer is available on this device.", e); }
            monitorSystemInstall(expectedPackage, expectedVersionCode, expectedDownloadId);
            return;
        }

        PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        long total = 0;
        for (File apk : apks) total += apk.length();
        params.setSize(total);
        if (Build.VERSION.SDK_INT >= 21 && expectedPackage != null && !expectedPackage.isEmpty()) params.setAppPackageName(expectedPackage);
        if (Build.VERSION.SDK_INT >= 31) params.setInstallScenario(android.content.pm.PackageManager.INSTALL_SCENARIO_FAST);
        if (Build.VERSION.SDK_INT >= 33) params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_STORE);

        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            int i = 0;
            for (File apk : apks) {
                String name = "apk-" + (i++) + "-" + apk.getName();
                try (InputStream in = new BufferedInputStream(new FileInputStream(apk));
                     OutputStream out = session.openWrite(name, 0, apk.length())) {
                    byte[] buf = new byte[1024 * 64];
                    int n; while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
                    session.fsync(out);
                }
            }
            Intent status = new Intent(getContext(), InstallResultReceiver.class);
            status.setPackage(getContext().getPackageName());
            status.putExtra("aem_download_path", file.getAbsolutePath());
            status.putExtra("aem_download_id", expectedDownloadId);
            PendingIntent pi = PendingIntent.getBroadcast(getContext(), INSTALL_RESULT, status, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            session.commit(pi.getIntentSender());
        } finally {
            session.close();
        }
    }

    private void monitorSystemInstall(final String packageName, final long targetVersionCode, final String downloadId) {
        if (packageName == null || packageName.isEmpty() || targetVersionCode < 0) return;
        new Thread(() -> {
            boolean installed = false;
            for (int attempt = 0; attempt < 90; attempt++) {
                try {
                    android.content.pm.PackageInfo p = getContext().getPackageManager().getPackageInfo(packageName, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES);
                    long code = Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
                    if (code >= targetVersionCode) { installed = true; break; }
                } catch (Exception ignored) {}
                try { Thread.sleep(1000L); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
            }
            JSObject out = new JSObject();
            out.put("downloadId", downloadId);
            out.put("success", installed);
            out.put("status", installed ? PackageInstaller.STATUS_SUCCESS : PackageInstaller.STATUS_FAILURE);
            out.put("message", installed ? "Installation completed" : "Installation was not completed");
            notifyListeners("installResult", out);
        }, "aem-system-install-monitor").start();
    }

    private void validatePackage(File file, String expectedPackage, String expectedSigningCert, long expectedVersionCode) throws Exception {
        if (expectedPackage == null || expectedPackage.isEmpty()) return;
        String lower = file.getName().toLowerCase(Locale.US);
        File inspect = file;
        if (lower.endsWith(".apks") || lower.endsWith(".xapk") || lower.endsWith(".apkm") || lower.endsWith(".zip")) {
            File dir = new File(file.getParentFile(), "validate-" + System.nanoTime());
            if (!dir.mkdirs()) throw new IOException("Cannot create validation directory");
            try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(file)))) {
                ZipEntry e;
                byte[] buf = new byte[65536];
                while ((e = zin.getNextEntry()) != null) {
                    if (e.isDirectory() || !e.getName().toLowerCase(Locale.US).endsWith(".apk")) continue;
                    File candidate = new File(dir, new File(e.getName()).getName());
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(candidate))) {
                        int n; while ((n = zin.read(buf)) >= 0) os.write(buf,0,n);
                    }
                    inspect = candidate;
                    break;
                }
            }
        }
        android.content.pm.PackageInfo info = getContext().getPackageManager().getPackageArchiveInfo(inspect.getAbsolutePath(), android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES);
        if (info == null || info.packageName == null) throw new IOException("Downloaded package metadata could not be read");
        if (!expectedPackage.equals(info.packageName)) throw new IOException("Package identity mismatch: expected " + expectedPackage + " but downloaded " + info.packageName);
        if (expectedVersionCode >= 0 && Build.VERSION.SDK_INT >= 28 && info.getLongVersionCode() != expectedVersionCode) {
            throw new IOException("Version code mismatch: expected " + expectedVersionCode + " but downloaded " + info.getLongVersionCode());
        }
        if (expectedSigningCert != null && !expectedSigningCert.isEmpty() && Build.VERSION.SDK_INT >= 28) {
            if (info.signingInfo == null) throw new IOException("Downloaded package has no signing information");
            android.content.pm.Signature[] signers = info.signingInfo.getApkContentsSigners();
            if (signers == null || signers.length == 0) throw new IOException("Downloaded package has no signing certificate");
            boolean match = false;
            for (android.content.pm.Signature signer : signers) {
                if (expectedSigningCert.replace(":", "").equalsIgnoreCase(certSha256(signer.toByteArray()))) { match = true; break; }
            }
            if (!match) throw new IOException("Signing certificate mismatch: downloaded APK is signed by a different key.");
        }
    }

    private void ensureInstalledCompatibility(String packageName, String expectedCert, long expectedVersionCode) throws Exception {
        if (packageName == null || packageName.isEmpty()) return;
        try {
            android.content.pm.PackageInfo installed = getContext().getPackageManager().getPackageInfo(packageName, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES);
            if (expectedVersionCode >= 0 && Build.VERSION.SDK_INT >= 28 && installed.getLongVersionCode() >= expectedVersionCode) {
                throw new IOException("Installed version code " + installed.getLongVersionCode() + " is already at or newer than store version " + expectedVersionCode);
            }
            if (expectedCert != null && !expectedCert.isEmpty() && Build.VERSION.SDK_INT >= 28) {
                if (!getContext().getPackageManager().hasSigningCertificate(packageName, hexBytes(expectedCert), android.content.pm.PackageManager.CERT_INPUT_SHA256)) {
                    throw new IOException("Installed package signature is incompatible with this update.");
                }
            }
        } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {}
    }

    private String signingCertificateSha256(android.content.pm.PackageInfo p) {
        if (Build.VERSION.SDK_INT < 28 || p.signingInfo == null) return "";
        try {
            android.content.pm.Signature[] signers = p.signingInfo.getApkContentsSigners();
            if (signers == null || signers.length == 0) return "";
            return certSha256(signers[0].toByteArray());
        } catch (Exception ignored) { return ""; }
    }

    private String certSha256(byte[] bytes) throws Exception {
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        byte[] digest = d.digest(bytes);
        StringBuilder out = new StringBuilder();
        for (byte b : digest) out.append(String.format(Locale.US, "%02x", b));
        return out.toString();
    }

    private byte[] hexBytes(String value) {
        String h = value.replace(":", "").replace(" ", "").trim();
        if ((h.length() & 1) != 0) throw new IllegalArgumentException("Invalid signing certificate digest");
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
}
