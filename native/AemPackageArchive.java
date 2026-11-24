package com.aem.store;

import java.io.*;
import java.util.*;
import java.util.zip.*;

/** Shared bounded extraction for catalog, external VIEW and received packages. */
public final class AemPackageArchive {
    private static final int MAX_ENTRIES = 512;
    private static final long MAX_FILE = 2L * 1024 * 1024 * 1024;
    private static final long MAX_TOTAL = 4L * 1024 * 1024 * 1024;
    private AemPackageArchive() {}

    public interface ProgressListener {
        void onProgress(long copiedBytes, long totalBytes);
    }

    /**
     * Wrap already-compressed APK files in an .apks ZIP without spending phone CPU trying to
     * recompress their contents. APKs are ZIP containers themselves, so DEFLATE level zero keeps
     * the bundle compatible while making preparation effectively a sequential copy.
     */
    public static void writeApkBundle(List<File> sources, File output, ProgressListener progress) throws IOException {
        if (sources == null || sources.isEmpty()) throw new IOException("No APK components to package");
        long total = 0L;
        for (File source : sources) {
            if (source == null || !source.isFile() || !source.canRead() || source.length() <= 0L) {
                throw new IOException("An APK component is missing or unreadable");
            }
            if (Long.MAX_VALUE - total < source.length()) throw new IOException("APK bundle is too large");
            total += source.length();
        }

        byte[] buffer = new byte[256 * 1024];
        long copied = 0L;
        try (ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(output), 128 * 1024))) {
            zip.setLevel(Deflater.NO_COMPRESSION);
            for (int index = 0; index < sources.size(); index++) {
                File source = sources.get(index);
                ZipEntry entry = new ZipEntry(index == 0 ? "base.apk" : "split-" + index + ".apk");
                zip.putNextEntry(entry);
                try (InputStream in = new BufferedInputStream(new FileInputStream(source), 128 * 1024)) {
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (read == 0) continue;
                        zip.write(buffer, 0, read);
                        copied += read;
                        if (progress != null) progress.onProgress(copied, total);
                    }
                }
                zip.closeEntry();
            }
        }
    }

    public static ArrayList<File> extract(File archive, File destination) throws IOException {
        ArrayList<File> result = new ArrayList<>();
        HashSet<String> names = new HashSet<>();
        long total = 0;
        int count = 0;
        try (ZipFile zip = new ZipFile(archive)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                if (++count > MAX_ENTRIES) throw new IOException("Package contains too many entries");
                if (name.startsWith("/") || name.contains("\\") || name.contains(":") || name.matches(".*[\\x00-\\x1f].*") || Arrays.asList(name.split("/")).contains("..")) throw new IOException("Unsafe package archive path");
                if (!names.add(name.toLowerCase(Locale.US))) throw new IOException("Duplicate package archive entry");
                long size = entry.getSize();
                if (size < 0 || size > MAX_FILE || (total += size) > MAX_TOTAL || size > Math.max(1, entry.getCompressedSize()) * 250L) throw new IOException("Package expansion exceeds safety limits");
                if (name.toLowerCase(Locale.US).endsWith(".obb")) throw new IOException("OBB asset installation is not supported; use the publisher installer or original phone");
                if (entry.isDirectory() || !name.toLowerCase(Locale.US).endsWith(".apk")) continue;
                // Never use an untrusted entry name as an output path.
                File file = new File(destination, "component-" + result.size() + ".apk");
                if (!file.createNewFile()) throw new IOException("Staging file already exists");
                CRC32 crc = new CRC32();
                long written = 0;
                try (InputStream in = new BufferedInputStream(zip.getInputStream(entry)); OutputStream out = new BufferedOutputStream(new FileOutputStream(file))) {
                    byte[] buffer = new byte[65536];
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        written += n;
                        if (written > size) throw new IOException("Decompressed package size mismatch");
                        out.write(buffer, 0, n);
                        crc.update(buffer, 0, n);
                    }
                }
                if (written != size || entry.getCrc() != crc.getValue()) throw new IOException("Corrupted package component");
                result.add(file);
            }
        } catch (IOException error) {
            deleteTree(destination);
            throw error;
        }
        if (result.isEmpty()) throw new IOException("Archive contains no APK components");
        return result;
    }

    public static void deleteTree(File file) {
        if (file == null) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
