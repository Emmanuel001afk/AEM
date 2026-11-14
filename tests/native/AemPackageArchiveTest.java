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
            ArrayList<File> files = AemPackageArchive.extract(archive(root,new String[]{"splits/base.apk","config.en.apk","metadata.json"}),out);
            if (files.size()!=2 || files.get(0).length()!=4 || !files.get(0).getName().equals("component-0.apk")) throw new AssertionError("Valid archive not extracted correctly");
        } finally { AemPackageArchive.deleteTree(root); }
        rejected(new String[]{"../base.apk"});
        rejected(new String[]{"base.apk","BASE.apk"});
        rejected(new String[]{"base.apk","main.obb"});
        rejected(new String[]{"C:base.apk"});
        String[] excessive = new String[513]; for (int i=0;i<excessive.length;i++) excessive[i]="file-"+i+".apk";
        rejected(excessive);
        System.out.println("PASS: 6 Java archive extraction scenarios (not Android installation tests)");
    }
}
