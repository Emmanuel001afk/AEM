package com.aem.store;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps a receive session (and an in-flight transfer) alive while AEM is in the
 * background, and gives the user a live status notification that opens Transfer.
 */
public class AemTransferService extends Service {
    private static final String CHANNEL_ID = "aem_transfer";
    private static final int NOTIFICATION_ID = 38177;
    private static final String EXTRA_TITLE = "aem_transfer_title";
    private static final String EXTRA_TEXT = "aem_transfer_text";

    private static AemTransferService instance;

    private String title = "AEM Transfer";
    private String text = "Waiting for a nearby phone";

    public static void start(Context context, String title, String text) {
        if (context == null) return;
        AemTransferService service = instance;
        if (service != null) {
            service.publish(title, text);
            return;
        }
        try {
            Intent intent = new Intent(context, AemTransferService.class);
            intent.putExtra(EXTRA_TITLE, title);
            intent.putExtra(EXTRA_TEXT, text);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception ignored) {
            // The service is a convenience; the transfer keeps running in the activity if it cannot start.
        }
    }

    public static void update(String title, String text) {
        AemTransferService service = instance;
        if (service != null) service.publish(title, text);
    }

    public static void stop(Context context) {
        if (context == null) return;
        try { context.stopService(new Intent(context, AemTransferService.class)); }
        catch (Exception ignored) { }
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null && Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "AEM Transfer", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shows local phone-to-phone transfer progress.");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, buildNotification());
            }
        } catch (Exception error) {
            stopSelf();
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String nextTitle = intent.getStringExtra(EXTRA_TITLE);
            String nextText = intent.getStringExtra(EXTRA_TEXT);
            if (nextTitle != null) title = nextTitle;
            if (nextText != null) text = nextText;
            publish(title, text);
        }
        return START_NOT_STICKY;
    }

    private void publish(String nextTitle, String nextText) {
        if (nextTitle != null && !nextTitle.trim().isEmpty()) title = nextTitle;
        if (nextText != null) text = nextText;
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
        } catch (Exception ignored) { }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, AemTransferActivity.class);
        boolean light = getSharedPreferences("aem_transfer", MODE_PRIVATE).getBoolean("light", false);
        open.putExtra("appearance", light ? "light" : "dark");
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(this, 0, open, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.aem_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setColor(0xFFF04444);
        if (Build.VERSION.SDK_INT >= 21) builder.setPriority(Notification.PRIORITY_LOW);
        return builder.build();
    }

    @Override public void onDestroy() {
        instance = null;
        try { stopForeground(true); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
