package com.aem.store;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.content.pm.PackageInstaller;

/**
 * Receives PackageInstaller status callbacks through a system-launched
 * PendingIntent. This activity is only a trampoline: when Android requires
 * user action, it launches the system-provided confirmation intent while the
 * launch is coming from the system PendingIntent path. Final statuses are
 * forwarded to the existing InstallResultReceiver.
 */
public class InstallConfirmationActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) {
            finish();
            return;
        }

        int status = intent.getIntExtra(
                PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE
        );

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = getParcelableExtraCompat(intent, Intent.EXTRA_INTENT);
            if (confirm != null) {
                try {
                    startActivity(confirm);
                } catch (Exception e) {
                    android.util.Log.e(
                            "AEM_INSTALL",
                            "Unable to launch install confirmation",
                            e
                    );
                }
            } else {
                android.util.Log.e(
                        "AEM_INSTALL",
                        "PackageInstaller requested user action but supplied no confirmation intent"
                );
            }
            finish();
            return;
        }

        Intent result = new Intent(this, InstallResultReceiver.class);
        result.putExtra(
                PackageInstaller.EXTRA_STATUS,
                status
        );
        result.putExtra(
                PackageInstaller.EXTRA_STATUS_MESSAGE,
                intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        );
        result.putExtra(
                "aem_download_id",
                intent.getStringExtra("aem_download_id")
        );
        result.putExtra(
                "aem_download_path",
                intent.getStringExtra("aem_download_path")
        );
        sendBroadcast(result);
        if (status == PackageInstaller.STATUS_SUCCESS) {
            new android.app.AlertDialog.Builder(this)
                    .setTitle("Installation complete")
                    .setMessage("AEM finished installing the downloaded package.")
                    .setPositiveButton("OK", (d, w) -> finish())
                    .setOnCancelListener(d -> finish())
                    .show();
        } else {
            String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            new android.app.AlertDialog.Builder(this)
                    .setTitle("Installation failed")
                    .setMessage(message == null || message.trim().isEmpty() ? "Android could not complete the installation." : message)
                    .setPositiveButton("OK", (d, w) -> finish())
                    .setOnCancelListener(d -> finish())
                    .show();
        }
    }

    @SuppressWarnings("deprecation")
    private Intent getParcelableExtraCompat(Intent source, String key) {
        if (Build.VERSION.SDK_INT >= 33) {
            return source.getParcelableExtra(key, Intent.class);
        }
        return source.getParcelableExtra(key);
    }
}
