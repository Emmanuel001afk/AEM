package com.aem.store;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
/** Plain-JVM extraction tests. These do not emulate PackageManager or Android installation. */
public class AemPackageArchiveTest {
    private static File archive(File root, String[] names) throws Exception {
        File file = new File(root,"test.zip");
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(file))) {
            for (String name : names) { zip.putNextEntry(new ZipEntry(name)); zip.write(new byte[]{1,2,3,4}); zip.closeEntry(); }
        }
        return file;
    }
    private static void bundleRoundTrip(File root) throws Exception {
        File base = new File(root, "source-base.apk");
        File split = new File(root, "source-split.apk");
        byte[] baseBytes = new byte[512 * 1024];
        byte[] splitBytes = new byte[128 * 1024];
        for (int i = 0; i < baseBytes.length; i++) baseBytes[i] = (byte) (i * 31 + 7);
        for (int i = 0; i < splitBytes.length; i++) splitBytes[i] = (byte) (i * 17 + 3);
        Files.write(base.toPath(), baseBytes);
        Files.write(split.toPath(), splitBytes);
        File bundle = new File(root, "app.apks");
        final long[] progress = {0L, 0L};
        AemPackageArchive.writeApkBundle(Arrays.asList(base, split), bundle, (copied, total) -> {
            progress[0] = copied;
            progress[1] = total;
        });
        try (ZipFile zip = new ZipFile(bundle)) {
            ZipEntry baseEntry = zip.getEntry("base.apk");
            ZipEntry splitEntry = zip.getEntry("split-1.apk");
            if (baseEntry == null || splitEntry == null) throw new AssertionError("Bundle is missing APK components");
            if (baseEntry.getMethod() != ZipEntry.DEFLATED || baseEntry.getCompressedSize() < baseEntry.getSize()) {
                throw new AssertionError("APK contents were recompressed instead of using the fast no-compression level");
            }
            byte[] readBase;
            byte[] readSplit;
            try (InputStream in = zip.getInputStream(baseEntry)) { readBase = in.readAllBytes(); }
            try (InputStream in = zip.getInputStream(splitEntry)) { readSplit = in.readAllBytes(); }
            if (!Arrays.equals(baseBytes, readBase) || !Arrays.equals(splitBytes, readSplit)) {
                throw new AssertionError("APK bundle changed component bytes");
            }
        }
        if (progress[0] != baseBytes.length + splitBytes.length || progress[1] != progress[0]) {
            throw new AssertionError("Bundle progress did not report the full copy");
        }
        File out = new File(root, "bundle-out");
        if (!out.mkdir()) throw new IOException("Could not create bundle test directory");
        ArrayList<File> unpacked = AemPackageArchive.extract(bundle, out);
        if (unpacked.size() != 2 || !Arrays.equals(baseBytes, Files.readAllBytes(unpacked.get(0).toPath()))
                || !Arrays.equals(splitBytes, Files.readAllBytes(unpacked.get(1).toPath()))) {
            throw new AssertionError("Created app bundle could not be extracted byte-for-byte");
        }
    }

    private static void rejected(String[] names) throws Exception {
        File root = Files.createTempDirectory("aem-native-test-").toFile();
        File out = new File(root,"out"); out.mkdir();
        try {
            File zip = archive(root,names);
            try { AemPackageArchive.extract(zip,out); throw new AssertionError("Unsafe archive accepted: " + Arrays.toString(names)); }
            catch (IOException expected) { }
        } finally { AemPackageArchive.deleteTree(root); }
    }
    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("aem-native-test-").toFile();
        File out = new File(root,"out"); out.mkdir();
        try {
            bundleRoundTrip(root);
            ArrayList<File> files = AemPackageArchive.extract(archive(root,new String[]{"splits/base.apk","config.en.apk","metadata.json"}),out);
            if (files.size()!=2 || files.get(0).length()!=4 || !files.get(0).getName().equals("component-0.apk")) throw new AssertionError("Valid archive not extracted correctly");
        } finally { AemPackageArchive.deleteTree(root); }
        rejected(new String[]{"../base.apk"});
        rejected(new String[]{"base.apk","BASE.apk"});
        rejected(new String[]{"base.apk","main.obb"});
        rejected(new String[]{"C:base.apk"});
        String[] excessive = new String[513]; for (int i=0;i<excessive.length;i++) excessive[i]="file-"+i+".apk";
        rejected(excessive);
        System.out.println("PASS: 7 Java archive extraction/bundle scenarios (not Android installation tests)");
    }
}
