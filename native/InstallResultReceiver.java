package com.aem.store;

public class InstallResultReceiver extends android.content.BroadcastReceiver {
    @Override
    public void onReceive(android.content.Context context, android.content.Intent intent) {
        int status = intent.getIntExtra(
                android.content.pm.PackageInstaller.EXTRA_STATUS,
                android.content.pm.PackageInstaller.STATUS_FAILURE
        );
        String message = intent.getStringExtra(
                android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE
        );

        if (status == android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION) {
            android.content.Intent confirm =
                    intent.getParcelableExtra(android.content.Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(confirm);
                } catch (Exception e) {
                    android.util.Log.e("AEM_INSTALL", "Unable to launch install confirmation", e);
                }
            }
            return;
        }

        android.util.Log.i("AEM_INSTALL", "status=" + status + " " + message);
        android.content.Intent event = new android.content.Intent("com.aem.store.INSTALL_RESULT");
        event.setPackage(context.getPackageName());
        event.putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, status);
        event.putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE, message);
        event.putExtra("aem_download_id", intent.getStringExtra("aem_download_id"));
        context.sendBroadcast(event);

        String path = intent.getStringExtra("aem_download_path");
        if (path != null && (status == android.content.pm.PackageInstaller.STATUS_SUCCESS
                || status >= android.content.pm.PackageInstaller.STATUS_FAILURE)) {
            try {
                java.io.File f = new java.io.File(path);
                if (f.exists()) f.delete();
            } catch (Exception ignored) {
            }
        }
    }
}
