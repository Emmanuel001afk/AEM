package com.aem.store;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

public class AemTransferService extends Service {
    private static final String CHANNEL_ID="aem_transfer";
    private static final int NOTIFICATION_ID=38177;

    @Override public void onCreate(){
        super.onCreate();
        NotificationManager nm=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        if(Build.VERSION.SDK_INT>=26){
            NotificationChannel ch=new NotificationChannel(CHANNEL_ID,"AEM Transfer",NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps an active local transfer running while AEM is in the background.");
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b=Build.VERSION.SDK_INT>=26
                ?new Notification.Builder(this,CHANNEL_ID)
                :new Notification.Builder(this);
        b.setSmallIcon(com.aem.store.R.drawable.aem_launcher)
         .setContentTitle("AEM Transfer")
         .setContentText("Local phone-to-phone transfer is active")
         .setOngoing(true)
         .setCategory(Notification.CATEGORY_PROGRESS)
         .setOnlyAlertOnce(true);
        Notification n=b.build();
        try{
            if(Build.VERSION.SDK_INT>=29)startForeground(NOTIFICATION_ID,n,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTIFICATION_ID,n);
        }catch(Exception e){stopSelf();}
    }

    @Override public int onStartCommand(Intent intent,int flags,int startId){return START_STICKY;}

    @Override public void onDestroy(){
        try{stopForeground(true);}catch(Exception ignored){}
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent){return null;}
}
