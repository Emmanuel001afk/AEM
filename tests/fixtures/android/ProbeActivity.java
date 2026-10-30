package com.aem.runtimeprobe;

import android.app.Activity;
import android.os.Bundle;
import android.Manifest;
import android.content.pm.PackageManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Minimal real Android test application. This is a test fixture, not the AEM product. */
public final class ProbeActivity extends Activity {
    private void write(String name, String value) {
        try (FileOutputStream output = new FileOutputStream(new File(getFilesDir(), name))) {
            output.write(value.getBytes("UTF-8"));
        } catch (Exception error) {
            throw new RuntimeException(error);
        }
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(48, 96, 48, 48);
        layout.setBackgroundColor(0xfff5f5f7);
        TextView title = new TextView(this);
        title.setText("AEM Android runtime probe");
        title.setTextSize(26);
        title.setTextColor(0xff17171c);
        final TextView detail = new TextView(this);
        detail.setText("Real Android activity\nLocal storage: ready\nHost network: checking…");
        detail.setTextSize(18);
        detail.setPadding(0, 32, 0, 0);
        layout.addView(title);
        layout.addView(detail);
        setContentView(layout);
        write("storage.txt", "storage-ok");
        write("camera-permission.txt", checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED ? "granted" : "denied");
        // Anonymous classes avoid javac's LambdaMetafactory dependency when compiling against android.jar.
        new Thread(new Runnable() {
            @Override public void run() {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL("http://10.0.2.2:8765/probe").openConnection();
                    connection.setConnectTimeout(5000);
                    connection.setReadTimeout(5000);
                    int status = connection.getResponseCode();
                    InputStream input = connection.getInputStream();
                    byte[] buffer = new byte[64];
                    int count = input.read(buffer);
                    input.close();
                    String body = count > 0 ? new String(buffer, 0, count, "UTF-8") : "";
                    if (status == 200 && body.equals("aem-network-ok")) {
                        write("network.txt", "network-ok");
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                detail.setText("Real Android activity\nLocal storage: verified\nHost network: verified\nAndroid permissions: managed by AEM");
                            }
                        });
                    } else { write("network.txt", "unexpected-response"); }
                } catch (Exception error) {
                    write("network.txt", "failed: " + error.getClass().getSimpleName());
                } finally { if (connection != null) connection.disconnect(); }
            }
        }, "aem-network-probe").start();
    }
}
