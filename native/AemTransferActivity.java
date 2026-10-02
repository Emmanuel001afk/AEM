package com.aem.store;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.*;
import android.content.pm.*;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.wifi.p2p.*;
import android.net.wifi.p2p.nsd.*;
import android.net.wifi.WifiManager;
import android.location.LocationManager;
import android.net.wifi.WpsInfo;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.Bitmap;
import android.util.Size;
import android.provider.OpenableColumns;
import android.view.*;
import android.widget.*;
import androidx.core.content.FileProvider;
import java.io.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

public class AemTransferActivity extends Activity {
    private static final int PORT=38177, PERM=7001, PICK=7002, FOLDER=7003;
    private static final int PROTOCOL=4;
    private WifiP2pManager manager; private WifiP2pManager.Channel channel; private BroadcastReceiver receiver;
    private WifiP2pDnsSdServiceInfo localService; private WifiP2pDnsSdServiceRequest serviceRequest;
    private final HashMap<String,String> peerNames=new HashMap<>();
    private final ExecutorService io=Executors.newCachedThreadPool();
    private final ArrayList<Item> selected=new ArrayList<>(); private final ArrayList<WifiP2pDevice> peers=new ArrayList<>();
    private LinearLayout root,peerBox,contentGrid; private TextView status,selectedText,categoryTitle,modeHint,deviceNameLabel; private ProgressBar progress; private RadarView radar; private ServerSocket server; private Button disconnectButton; private boolean sending=false; private boolean transferActive=false; private boolean connectionActive=false; private String connectedHost=null; private boolean waitingForWifi=false; private boolean waitingForLocation=false; private String pendingAction=null; private String transferId=null; private String activeCategory="Apps"; private final HashMap<String,ArrayList<Item>> exportedApps=new HashMap<>(); private final ArrayList<TextView> categoryButtons=new ArrayList<>();

    private static final class Item {
        final Uri uri; final String name; final long size;
        Item(Uri u,String n,long s){uri=u;name=n;size=Math.max(0,s);}
    }

    private static final class SpeedMeter {
        final long startNanos=System.nanoTime();
        long lastBytes;
        long lastNanos=startNanos;
        String formatRate(long bytes){
            long now=System.nanoTime();
            long elapsed=Math.max(1,now-lastNanos);
            long delta=bytes-lastBytes;
            double mbps=(delta*1_000_000_000.0/elapsed)/1048576.0;
            if(elapsed>250_000_000L){lastBytes=bytes;lastNanos=now;}
            return mbps<0.1?"0.0 MB/s":String.format(Locale.US,"%.1f MB/s",mbps);
        }
    }

    @Override public void onCreate(Bundle b){
        super.onCreate(b); buildUi();
        manager=(WifiP2pManager)getSystemService(WIFI_P2P_SERVICE);
        channel=manager==null?null:manager.initialize(this,getMainLooper(),null);
        receiver=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){
            String a=i.getAction();
            if(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION.equals(a)){
                int state=i.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE,-1);
                if(state==WifiP2pManager.WIFI_P2P_STATE_DISABLED) status.setText("Wi-Fi Direct is off. Turn on Wi-Fi, then try again.");
            }
            if(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(a)) requestPeers();
            if(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(a)) requestConnection();
        }};
        IntentFilter f=new IntentFilter(); f.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION); f.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION); f.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        if(Build.VERSION.SDK_INT>=33) registerReceiver(receiver,f,Context.RECEIVER_EXPORTED); else registerReceiver(receiver,f);
    }

    private int dp(int v){return (int)(v*getResources().getDisplayMetrics().density+0.5f);}
    private GradientDrawable bg(int color,int radius){GradientDrawable g=new GradientDrawable();g.setColor(color);g.setCornerRadius(dp(radius));return g;}
    private Button actionButton(String text){Button b=new Button(this);b.setText(text);b.setTextSize(15);b.setAllCaps(false);b.setTextColor(Color.WHITE);b.setMinHeight(dp(52));b.setPadding(dp(12),0,dp(12),0);return b;}

    private void buildUi(){
        root=new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16),dp(14),dp(16),dp(12));
        root.setBackgroundColor(Color.rgb(8,9,12));

        LinearLayout top=new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView title=new TextView(this);
        title.setText("Transfer");
        title.setTextSize(26);
        title.setTextColor(Color.WHITE);
        title.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        top.addView(title,new LinearLayout.LayoutParams(0,dp(44),1));
        TextView close=new TextView(this);
        close.setText("×");
        close.setTextSize(30);
        close.setGravity(Gravity.CENTER);
        close.setTextColor(Color.WHITE);
        close.setOnClickListener(v->finish());
        top.addView(close,new LinearLayout.LayoutParams(dp(44),dp(44)));
        root.addView(top);

        TextView sub=new TextView(this);
        sub.setText("Direct phone-to-phone transfer • no internet or cloud");
        sub.setTextSize(13);
        sub.setTextColor(Color.rgb(170,175,185));
        root.addView(sub,new LinearLayout.LayoutParams(-1,dp(30)));

        deviceNameLabel=label("This device: "+transferName()+"  •  Edit",13,Color.rgb(130,170,255));
        deviceNameLabel.setPadding(2,0,2,4);
        deviceNameLabel.setOnClickListener(v->showTransferNameDialog());
        root.addView(deviceNameLabel,new LinearLayout.LayoutParams(-1,dp(34)));

        LinearLayout modes=new LinearLayout(this);
        modes.setPadding(0,dp(8),0,dp(8));
        Button send=actionButton("Send");
        Button receive=actionButton("Receive");
        send.setTextSize(16);receive.setTextSize(16);
        send.setTextColor(Color.WHITE);receive.setTextColor(Color.WHITE);
        send.setBackground(bg(Color.rgb(50,92,210),14));
        receive.setBackground(bg(Color.rgb(31,34,41),14));
        LinearLayout.LayoutParams mp=new LinearLayout.LayoutParams(0,dp(58),1);mp.setMargins(0,0,dp(6),0);modes.addView(send,mp);
        LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(0,dp(58),1);rp.setMargins(dp(6),0,0,0);modes.addView(receive,rp);
        root.addView(modes);

        modeHint=label("Choose what to send, then select a nearby phone.",13,Color.rgb(170,175,185));
        modeHint.setPadding(2,2,2,8);
        root.addView(modeHint,new LinearLayout.LayoutParams(-1,dp(30)));

        categoryTitle=new TextView(this);
        categoryTitle.setText("Apps");
        categoryTitle.setTextSize(19);
        categoryTitle.setTextColor(Color.WHITE);
        categoryTitle.setTypeface(null,1);
        categoryTitle.setPadding(0,dp(8),0,dp(8));
        root.addView(categoryTitle,new LinearLayout.LayoutParams(-1,dp(42)));

        HorizontalScrollView tabsScroll=new HorizontalScrollView(this);
        tabsScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout tabs=new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        String[] categories={"Apps","Photos","Videos","Music","Files"};
        for(String c:categories){
            TextView b=new TextView(this);
            categoryButtons.add(b);
            b.setText(c);b.setTextSize(14);b.setGravity(Gravity.CENTER);b.setTextColor(Color.LTGRAY);
            b.setPadding(dp(18),0,dp(18),0);
            b.setBackground(bg(Color.rgb(27,29,35),22));
            b.setOnClickListener(v->{activeCategory=c;renderCategory();});
            LinearLayout.LayoutParams tp=new LinearLayout.LayoutParams(-2,dp(42));tp.setMargins(0,0,dp(8),0);tabs.addView(b,tp);
        }
        tabsScroll.addView(tabs);
        root.addView(tabsScroll,new LinearLayout.LayoutParams(-1,dp(50)));

        contentGrid=new LinearLayout(this);
        contentGrid.setOrientation(LinearLayout.VERTICAL);
        contentGrid.setPadding(0,dp(8),0,dp(8));
        ScrollView contentScroll=new ScrollView(this);
        contentScroll.setFillViewport(true);
        contentScroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        contentScroll.addView(contentGrid);
        root.addView(contentScroll,new LinearLayout.LayoutParams(-1,0,1));

        LinearLayout selectedBar=new LinearLayout(this);
        selectedBar.setGravity(Gravity.CENTER_VERTICAL);
        selectedBar.setPadding(dp(14),0,dp(14),0);
        selectedBar.setBackground(bg(Color.rgb(24,26,32),14));
        selectedText=new TextView(this);
        selectedText.setTextColor(Color.WHITE);selectedText.setTextSize(13);
        selectedBar.addView(selectedText,new LinearLayout.LayoutParams(0,dp(48),1));
        TextView clear=new TextView(this);clear.setText("Clear");clear.setTextColor(Color.rgb(130,170,255));clear.setGravity(Gravity.CENTER);
        clear.setOnClickListener(v->{selected.clear();exportedApps.clear();refreshSelectedText();});
        selectedBar.addView(clear,new LinearLayout.LayoutParams(dp(60),dp(48)));
        root.addView(selectedBar,new LinearLayout.LayoutParams(-1,dp(52)));

        status=new TextView(this);
        status.setTextColor(Color.rgb(190,195,205));status.setTextSize(12);
        status.setPadding(dp(2),dp(6),dp(2),dp(4));
        root.addView(status,new LinearLayout.LayoutParams(-1,dp(28)));

        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress,new LinearLayout.LayoutParams(-1,dp(5)));

        radar=new RadarView(this);
        root.addView(radar,new LinearLayout.LayoutParams(-1,dp(168)));

        peerBox=new LinearLayout(this);
        peerBox.setOrientation(LinearLayout.VERTICAL);
        peerBox.setPadding(0,dp(4),0,0);
        root.addView(peerBox);

        LinearLayout bottom=new LinearLayout(this);
        Button chooseFiles=actionButton("Add files");
        Button chooseFolder=actionButton("Add folder");
        LinearLayout.LayoutParams bp=new LinearLayout.LayoutParams(0,dp(50),1);bp.setMargins(0,dp(6),dp(5),0);bottom.addView(chooseFiles,bp);
        LinearLayout.LayoutParams fp=new LinearLayout.LayoutParams(0,dp(50),1);fp.setMargins(dp(5),dp(6),0,0);bottom.addView(chooseFolder,fp);
        root.addView(bottom,new LinearLayout.LayoutParams(-1,dp(56)));

        disconnectButton=actionButton("Disconnect");
        disconnectButton.setBackground(bg(Color.rgb(60,62,70),12));
        disconnectButton.setEnabled(false);
        disconnectButton.setOnClickListener(v->disconnectTransfer());
        root.addView(disconnectButton,new LinearLayout.LayoutParams(-1,dp(46)));

        setContentView(root);

        chooseFiles.setOnClickListener(v->pickFiles());
        chooseFolder.setOnClickListener(v->pickFolder());
        receive.setOnClickListener(v->startReceive());
        send.setOnClickListener(v->{
            if(selected.isEmpty()){status.setText("Select something to send first.");return;}
            if(connectionActive&&connectedHost!=null){
                sending=false;
                beginTransferSession();
                status.setText("Sending another selection over the active connection…");
                io.execute(()->sendFiles(connectedHost));
            }else discover();
        });
        refreshSelectedText();
        status.setText("Ready");
        updateCategoryButtons();
        renderCategory();
    }
    private boolean hasPermission(){
        return Build.VERSION.SDK_INT>=33?checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES)==PackageManager.PERMISSION_GRANTED:checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }
    private String[] requiredPermissions(){
        ArrayList<String> p=new ArrayList<>();
        if(Build.VERSION.SDK_INT>=33) p.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        else if(Build.VERSION.SDK_INT>=23){
            p.add(Manifest.permission.ACCESS_FINE_LOCATION);
            p.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if(Build.VERSION.SDK_INT<33 && Build.VERSION.SDK_INT>=23){p.add(Manifest.permission.READ_EXTERNAL_STORAGE);}
        return p.toArray(new String[0]);
    }
    @Override public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);if(r==PERM){if(hasPermission()){String action=pendingAction;pendingAction=null;if("send".equals(action))discover();else if("receive".equals(action))startReceive();else {status.setText("Permission granted. Ready.");renderCategory();}}else status.setText("Nearby-device permission was not granted.");}}
    @Override protected void onResume(){
        super.onResume();
        if(waitingForWifi && wifiEnabled()){
            waitingForWifi=false;
            status.setText("Wi-Fi is on • resuming nearby-device scan…");
            if(sending) discover(); else if(modeHint!=null&&modeHint.getText().toString().startsWith("Receive mode:")) startReceive();
        }else if(waitingForLocation && locationEnabled()){
            waitingForLocation=false;
            status.setText("Location services are on • resuming nearby-device scan…");
            if(sending) discover();
        }
    }

    private void renderCategory(){
        if(contentGrid==null)return;
        contentGrid.removeAllViews();
        categoryTitle.setText(activeCategory);
        updateCategoryButtons();
        if("Apps".equals(activeCategory)){renderApps();return;}
        if("Files".equals(activeCategory)){renderFiles();return;}
        renderMedia(activeCategory);
    }

    private TextView label(String text,int size,int color){
        TextView v=new TextView(this);v.setText(text);v.setTextSize(size);v.setTextColor(color);return v;
    }

    private String transferName(){
        String saved=getSharedPreferences("aem_transfer",MODE_PRIVATE).getString("name","");
        if(saved!=null&&!saved.trim().isEmpty())return saved.trim();
        String system=null;
        try{system=android.provider.Settings.Global.getString(getContentResolver(),android.provider.Settings.Global.DEVICE_NAME);}catch(Exception ignored){}
        if(system!=null&&!system.trim().isEmpty())return system.trim();
        return Build.MODEL==null?"Android phone":Build.MODEL;
    }

    private void showTransferNameDialog(){
        final EditText input=new EditText(this);
        input.setSingleLine(true); input.setText(transferName()); input.setSelectAllOnFocus(true);
        AlertDialog dialog=new AlertDialog.Builder(this)
                .setTitle("Transfer device name")
                .setMessage("Use your Android device name or choose a custom name. This name is shown to nearby AEM receivers.")
                .setView(input).setNegativeButton("Cancel",null).setPositiveButton("Save",null).create();
        dialog.setOnShowListener(v->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(x->{
            String name=input.getText().toString().trim();
            if(name.isEmpty())name=Build.MODEL==null?"Android phone":Build.MODEL;
            if(name.length()>48)name=name.substring(0,48).trim();
            getSharedPreferences("aem_transfer",MODE_PRIVATE).edit().putString("name",name).apply();
            if(deviceNameLabel!=null)deviceNameLabel.setText("This device: "+name+"  •  Edit");
            if(!sending&&manager!=null&&channel!=null)registerReceiverService();
            dialog.dismiss();
        }));
        dialog.show();
    }

    private void registerReceiverService(){
        if(manager==null||channel==null)return;
        try{
            if(localService!=null){
                manager.removeLocalService(channel,localService,new WifiP2pManager.ActionListener(){
                    public void onSuccess(){addReceiverService();}
                    public void onFailure(int r){addReceiverService();}
                });
            }else addReceiverService();
        }catch(Exception e){addReceiverService();}
    }

    private void addReceiverService(){
        try{
            HashMap<String,String> record=new HashMap<>();
            record.put("name",transferName()); record.put("role","receiver");
            record.put("port",String.valueOf(PORT)); record.put("protocol",String.valueOf(PROTOCOL));
            String instance=("AEM-"+transferName()).replaceAll("[^A-Za-z0-9_-]","-");
            if(instance.length()>50)instance=instance.substring(0,50);
            localService=WifiP2pDnsSdServiceInfo.newInstance(instance,"_aemtransfer._tcp",record);
            manager.addLocalService(channel,localService,new WifiP2pManager.ActionListener(){
                public void onSuccess(){}
                public void onFailure(int r){localService=null;}
            });
        }catch(Exception ignored){localService=null;}
    }

    private void prepareServiceDiscovery(){
        if(manager==null||channel==null)return;
        try{
            manager.setDnsSdResponseListeners(channel,
                (instanceName,registrationType,device)->{},
                (fullDomain,record,device)->{
                    Object role=record.get("role"); Object name=record.get("name");
                    if("receiver".equals(String.valueOf(role))&&name!=null){
                        peerNames.put(device.deviceAddress,String.valueOf(name));
                        runOnUiThread(()->renderPeers());
                    }
                });
            manager.clearServiceRequests(channel,new WifiP2pManager.ActionListener(){
                public void onSuccess(){addServiceDiscoveryRequest();}
                public void onFailure(int r){addServiceDiscoveryRequest();}
            });
        }catch(Exception ignored){}
    }

    private void addServiceDiscoveryRequest(){
        try{
            serviceRequest=WifiP2pDnsSdServiceRequest.newInstance();
            manager.addServiceRequest(channel,serviceRequest,new WifiP2pManager.ActionListener(){
                public void onSuccess(){try{manager.discoverServices(channel,null);}catch(Exception ignored){}}
                public void onFailure(int r){}
            });
        }catch(Exception ignored){}
    }

    private final class RadarView extends View {
        private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        RadarView(Context c){super(c);}
        @Override protected void onDraw(Canvas c){
            super.onDraw(c);
            float cx=getWidth()/2f,cy=getHeight()/2f,radius=Math.min(getWidth(),getHeight())*0.34f;
            paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(1));paint.setColor(Color.rgb(42,65,105));
            for(int i=1;i<=3;i++)c.drawCircle(cx,cy,radius*i/3f,paint);
            c.drawLine(cx-radius,cy,cx+radius,cy,paint); c.drawLine(cx,cy-radius,cx,cy+radius,paint);
            paint.setStyle(Paint.Style.FILL);paint.setColor(Color.rgb(70,120,220));c.drawCircle(cx,cy,dp(5),paint);
            double sweep=(System.currentTimeMillis()%2600L)/2600.0*Math.PI*2;
            paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(2));paint.setColor(Color.rgb(80,150,255));
            c.drawArc(cx-radius,cy-radius,cx+radius,cy+radius,(float)Math.toDegrees(sweep),55,false,paint);
            for(int i=0;i<peers.size();i++){
                WifiP2pDevice d=peers.get(i);
                float angle=(float)((i%Math.max(1,peers.size()))*Math.PI*2.0/Math.max(1,peers.size()));
                float rr=radius*(0.35f+0.5f*((i%3)/2f));
                paint.setStyle(Paint.Style.FILL);paint.setColor(Color.rgb(110,210,150));
                c.drawCircle(cx+(float)Math.cos(angle)*rr,cy+(float)Math.sin(angle)*rr,dp(5),paint);
            }
            paint.setColor(Color.LTGRAY);paint.setTextSize(dp(12));paint.setTextAlign(Paint.Align.CENTER);
            int count=peers.size(); c.drawText(count+" nearby "+(count==1?"device":"devices"),cx,getHeight()-dp(8),paint);
            postInvalidateDelayed(100);
        }
    }

    private void updateCategoryButtons(){
        for(TextView b:categoryButtons){
            boolean active=b.getText().toString().equals(activeCategory);
            b.setTextColor(active?Color.WHITE:Color.LTGRAY);
            b.setTypeface(Typeface.DEFAULT,active?Typeface.BOLD:Typeface.NORMAL);
            b.setBackground(bg(active?Color.rgb(50,92,210):Color.rgb(27,29,35),22));
        }
    }

    private TextView section(String text){
        TextView v=label(text,14,Color.rgb(170,175,185));
        v.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        v.setPadding(0,dp(10),0,dp(8));
        return v;
    }

    private void renderApps(){
        contentGrid.removeAllViews();
        contentGrid.addView(section("INSTALLED APPLICATIONS"));
        TextView loading=label("Loading installed apps…",14,Color.LTGRAY);
        loading.setPadding(0,dp(12),0,dp(12));
        contentGrid.addView(loading);
        io.execute(()->{
            PackageManager pm=getPackageManager();
            ArrayList<ApplicationInfo> all=new ArrayList<>();
            try{all.addAll(pm.getInstalledApplications(PackageManager.GET_META_DATA));}catch(Exception ignored){}
            all.removeIf(a->a.packageName.equals(getPackageName()));
            Collections.sort(all,(a,b)->String.valueOf(pm.getApplicationLabel(a)).compareToIgnoreCase(String.valueOf(pm.getApplicationLabel(b))));
            final ArrayList<ApplicationInfo> apps=all;
            runOnUiThread(()->showInstalledApps(apps));
        });
    }

    private void showInstalledApps(ArrayList<ApplicationInfo> all){
        contentGrid.removeAllViews();
        contentGrid.addView(section(all.size()+" APPLICATIONS AVAILABLE"));
        GridLayout grid=new GridLayout(this);grid.setColumnCount(2);
        PackageManager pm=getPackageManager();
        int limit=Math.min(all.size(),300);
        for(int index=0;index<limit;index++){
            ApplicationInfo app=all.get(index);
            LinearLayout card=new LinearLayout(this);card.setOrientation(LinearLayout.VERTICAL);card.setPadding(dp(10),dp(10),dp(10),dp(10));
            card.setBackground(bg(Color.rgb(25,27,32),16));
            CheckBox box=new CheckBox(this);box.setText("SELECT");box.setTextColor(Color.LTGRAY);box.setTextSize(11);
            ImageView icon=new ImageView(this);
            icon.setImageResource(android.R.drawable.sym_def_app_icon); final ImageView iconView=icon; io.execute(()->{try{Drawable d=pm.getApplicationIcon(app);runOnUiThread(()->iconView.setImageDrawable(d));}catch(Exception ignored){}});
            card.addView(icon,new LinearLayout.LayoutParams(-1,dp(64)));
            TextView name=label(String.valueOf(pm.getApplicationLabel(app)),14,Color.WHITE);
            name.setTypeface(Typeface.DEFAULT,Typeface.BOLD);name.setGravity(Gravity.CENTER);
            card.addView(name,new LinearLayout.LayoutParams(-1,-2));
            TextView pkg=label(app.packageName,9,Color.GRAY);pkg.setGravity(Gravity.CENTER);card.addView(pkg);
            TextView badge=label(isSystemApp(app)?"SYSTEM APP":"INSTALLED APP",9,isSystemApp(app)?Color.rgb(255,190,80):Color.rgb(110,210,150));
            badge.setGravity(Gravity.CENTER);card.addView(badge);
            box.setOnCheckedChangeListener((button,checked)->{
                button.setEnabled(false);
                final String packageName=app.packageName;
                if(checked){
                    String appLabel=String.valueOf(pm.getApplicationLabel(app));
                    status.setText("Preparing "+appLabel+"…");
                    io.execute(()->{
                        ArrayList<Item> made=new ArrayList<>();
                        boolean ok=exportInstalledApp(app,made)>0;
                        runOnUiThread(()->{
                            if(button.isChecked()&&ok){
                                exportedApps.put(packageName,made);
                                for(Item x:made){selected.removeIf(oldItem->oldItem.name.equals(x.name));selected.add(x);}
                            }
                            button.setEnabled(true);
                            status.setText(ok?"Ready • "+appLabel+" can be sent":"Could not prepare "+appLabel);
                            refreshSelectedText();
                        });
                    });
                }else{
                    io.execute(()->{
                        ArrayList<Item> made=exportedApps.remove(packageName);
                        runOnUiThread(()->{
                            if(made!=null)selected.removeAll(made);
                            button.setEnabled(true);refreshSelectedText();
                        });
                    });
                }
            });
            card.addView(box);
            GridLayout.LayoutParams gp=new GridLayout.LayoutParams();
            gp.width=0;gp.height=GridLayout.LayoutParams.WRAP_CONTENT;
            gp.columnSpec=GridLayout.spec(GridLayout.UNDEFINED,1f);
            gp.setMargins(dp(4),dp(4),dp(4),dp(4));
            grid.addView(card,gp);
        }
        contentGrid.addView(grid);
        if(all.size()>limit)contentGrid.addView(label("Showing the first "+limit+" apps. Use Add files to transfer an APK directly.",12,Color.GRAY));
    }

    private void renderMedia(String category){
        String permission=category.equals("Photos")?Manifest.permission.READ_MEDIA_IMAGES:category.equals("Videos")?Manifest.permission.READ_MEDIA_VIDEO:Manifest.permission.READ_MEDIA_AUDIO;
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED){
            Button allow=new Button(this);allow.setText("ALLOW "+category.toUpperCase()+" ACCESS");
            allow.setOnClickListener(v->requestPermissions(new String[]{permission},PERM));
            contentGrid.addView(label("AEM needs permission to show "+category.toLowerCase()+" directly in the transfer picker.",14,Color.LTGRAY));
            contentGrid.addView(allow);return;
        }
        io.execute(()->{
            ArrayList<Item> items=new ArrayList<>();
            Uri base=category.equals("Photos")?MediaStore.Images.Media.EXTERNAL_CONTENT_URI:category.equals("Videos")?MediaStore.Video.Media.EXTERNAL_CONTENT_URI:MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            String[] proj={MediaStore.MediaColumns._ID,MediaStore.MediaColumns.DISPLAY_NAME,MediaStore.MediaColumns.SIZE};
            Cursor c=null;try{
                c=getContentResolver().query(base,proj,null,null,MediaStore.MediaColumns.DATE_ADDED+" DESC");
                if(c!=null){
                    int id=c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID),name=c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME),size=c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
                    int count=0;
                    while(c.moveToNext()&&count++<100){
                        long row=c.getLong(id);String n=c.getString(name);long z=c.isNull(size)?0:c.getLong(size);
                        items.add(new Item(ContentUris.withAppendedId(base,row),n,z));
                    }
                }
            }catch(Exception e){runOnUiThread(()->status.setText("Could not load "+category+": "+safe(e)));}finally{if(c!=null)c.close();}
            runOnUiThread(()->showMediaItems(category,items));
        });
    }

    private void showMediaItems(String category,ArrayList<Item> items){
        contentGrid.removeAllViews();
        contentGrid.addView(section(items.size()+" "+category.toUpperCase()+" AVAILABLE"));
        for(Item x:items){
            LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(10),dp(8),dp(10),dp(8));row.setBackground(bg(Color.rgb(24,26,31),14));
            ImageView thumb=new ImageView(this); thumb.setScaleType(ImageView.ScaleType.CENTER_CROP); thumb.setImageResource(android.R.drawable.ic_menu_gallery); row.addView(thumb,new LinearLayout.LayoutParams(dp(70),dp(70))); if(!category.equals("Music"))loadThumbnail(thumb,x.uri);
            LinearLayout textBox=new LinearLayout(this);textBox.setOrientation(LinearLayout.VERTICAL);
            textBox.addView(label(x.name,14,Color.WHITE));textBox.addView(label(format(x.size),11,Color.GRAY));
            row.addView(textBox,new LinearLayout.LayoutParams(0,-2,1));
            CheckBox box=new CheckBox(this);box.setText("SELECT");box.setTextColor(Color.LTGRAY);
            box.setOnCheckedChangeListener((b,checked)->{if(checked){if(!containsItem(x))selected.add(x);}else removeItem(x);refreshSelectedText();});
            row.addView(box);
            contentGrid.addView(row,new LinearLayout.LayoutParams(-1,-2));
        }
        if(items.isEmpty())contentGrid.addView(label("No "+category.toLowerCase()+" found on this device.",14,Color.GRAY));
    }

    private boolean containsItem(Item x){for(Item y:selected)if(String.valueOf(y.uri).equals(String.valueOf(x.uri)))return true;return false;}
    private void removeItem(Item x){Iterator<Item> it=selected.iterator();while(it.hasNext())if(String.valueOf(it.next().uri).equals(String.valueOf(x.uri)))it.remove();}

    private void loadThumbnail(ImageView view,Uri uri){
        if(Build.VERSION.SDK_INT<29)return;
        io.execute(()->{
            try{
                Bitmap b=getContentResolver().loadThumbnail(uri,new Size(120,120),null);
                runOnUiThread(()->view.setImageBitmap(b));
            }catch(Exception ignored){}
        });
    }

    private void renderFiles(){
        contentGrid.addView(section("FILES & DOCUMENTS"));
        contentGrid.addView(label("Documents, ZIPs, APKs and folders are transferred directly. AEM does not open or play them.",13,Color.LTGRAY));
        Button b=new Button(this);b.setText("BROWSE FILES");b.setOnClickListener(v->pickFiles());contentGrid.addView(b);
        Button f=new Button(this);f.setText("BROWSE FOLDER");f.setOnClickListener(v->pickFolder());contentGrid.addView(f);
        contentGrid.addView(label("Selected files stay in the transfer list below.",12,Color.GRAY));
    }

    private int exportInstalledApp(ApplicationInfo app,ArrayList<Item> made){
        try{
            File dir=new File(getCacheDir(),"aem-downloads");
            if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cannot create transfer cache");
            ArrayList<String> paths=new ArrayList<>();
            if(app.sourceDir!=null)paths.add(app.sourceDir);
            if(app.splitSourceDirs!=null)Collections.addAll(paths,app.splitSourceDirs);
            if(paths.isEmpty())throw new IOException("No readable APK components found");
            String label=String.valueOf(getPackageManager().getApplicationLabel(app));
            File out=new File(dir,app.packageName+".apks");
            File meta=new File(dir,app.packageName+".meta");
            StringBuilder fingerprint=new StringBuilder();
            for(String path:paths){File src=new File(path);if(!src.isFile()||!src.canRead())continue;fingerprint.append(path).append("|").append(src.length()).append("|").append(src.lastModified()).append("\n");}
            String fp=fingerprint.toString();
            if(out.isFile()&&out.length()>0&&meta.isFile()){
                String cached=new String(java.nio.file.Files.readAllBytes(meta.toPath()),java.nio.charset.StandardCharsets.UTF_8);
                if(cached.equals(fp)){made.add(new Item(FileProvider.getUriForFile(this,getPackageName()+".fileprovider",out),label+" ("+app.packageName+").apks",out.length()));return 1;}
            }
            File temp=new File(dir,app.packageName+".apks.tmp");
            try(ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(temp),1024*1024))){
                byte[] b=new byte[1024*1024];int component=0;
                for(String path:paths){File src=new File(path);if(!src.isFile()||!src.canRead())continue;String entry=component++==0?"base.apk":"split-"+component+".apk";zip.putNextEntry(new ZipEntry(entry));try(InputStream in=new BufferedInputStream(new FileInputStream(src),1024*1024)){int n;while((n=in.read(b))!=-1)if(n>0)zip.write(b,0,n);}zip.closeEntry();}
                if(component==0)throw new IOException("No readable APK components found");
            }
            if(out.exists())out.delete();
            if(!temp.renameTo(out))throw new IOException("Could not finalize cached package");
            try(FileOutputStream m=new FileOutputStream(meta)){m.write(fp.getBytes(java.nio.charset.StandardCharsets.UTF_8));}
            made.add(new Item(FileProvider.getUriForFile(this,getPackageName()+".fileprovider",out),label+" ("+app.packageName+").apks",out.length()));
            return 1;
        }catch(Exception e){update("Could not prepare "+app.packageName+": "+(e.getMessage()==null?"access denied":e.getMessage()),0);return 0;}
    }
    private void pickFiles(){Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("*/*");i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);startActivityForResult(i,PICK);}
    private void pickFolder(){Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(i,FOLDER);}
    @Override protected void onActivityResult(int r,int code,Intent data){
        super.onActivityResult(r,code,data); if(data==null)return;
        if(r==PICK){if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)addUri(data.getClipData().getItemAt(i).getUri(),null);
            else if(data.getData()!=null)addUri(data.getData(),null);}
        else if(r==FOLDER){Uri u=data.getData();if(u!=null){try{getContentResolver().takePersistableUriPermission(u,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){};addTree(u);}}
        refreshSelectedText();
    }
    private void addUri(Uri u,String forcedName){try{getContentResolver().takePersistableUriPermission(u,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}String n=forcedName==null?displayName(u):forcedName;long s=size(u);if(s<0)s=0;selected.add(new Item(u,n,s));}
    private void addTree(Uri tree){addTree(tree,"");}
    private void addTree(Uri tree,String relative){
        Cursor c=null;try{String doc=DocumentsContract.getTreeDocumentId(tree);Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,doc);
            c=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE},null,null,null);
            if(c!=null)while(c.moveToNext()){String id=c.getString(0),name=c.getString(1),mime=c.getString(2);Uri child=DocumentsContract.buildDocumentUriUsingTree(tree,id);
                String path=relative.isEmpty()?name:relative+"/"+name;
                if(DocumentsContract.Document.MIME_TYPE_DIR.equals(mime))addTree(child,path);
                else selected.add(new Item(child,path,Math.max(0,c.isNull(3)?size(child):c.getLong(3))));
            }
        }catch(Exception e){update("Folder selection failed: "+e.getMessage(),0);}finally{if(c!=null)c.close();}}
    private String displayName(Uri u){Cursor c=null;try{c=getContentResolver().query(u,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null);return c!=null&&c.moveToFirst()&&!c.isNull(0)?c.getString(0):"AEM-file";}catch(Exception e){return u.getLastPathSegment()==null?"AEM-file":u.getLastPathSegment();}finally{if(c!=null)c.close();}}
    private long size(Uri u){Cursor c=null;try{c=getContentResolver().query(u,new String[]{OpenableColumns.SIZE},null,null,null);return c!=null&&c.moveToFirst()&&!c.isNull(0)?c.getLong(0):0;}catch(Exception e){return 0;}finally{if(c!=null)c.close();}}
    private void refreshSelectedText(){long total=0;for(Item x:selected)total+=x.size;selectedText.setText(selected.size()+" item"+(selected.size()==1?"":"s")+" selected · "+format(total));}
    private String format(long n){double x=n;if(x<1024)return n+" B";if(x<1048576)return String.format(Locale.US,"%.1f KB",x/1024);if(x<1073741824)return String.format(Locale.US,"%.1f MB",x/1048576);return String.format(Locale.US,"%.2f GB",x/1073741824);}

    private void pickInstalledApps(){
        PackageManager pm=getPackageManager();List<ApplicationInfo> all=pm.getInstalledApplications(PackageManager.GET_META_DATA);all.removeIf(a->a.packageName.equals(getPackageName()));
        Collections.sort(all,(a,b)->String.valueOf(pm.getApplicationLabel(a)).compareToIgnoreCase(String.valueOf(pm.getApplicationLabel(b))));
        String[] labels=new String[all.size()];boolean[] checked=new boolean[all.size()];
        for(int i=0;i<all.size();i++){ApplicationInfo a=all.get(i);labels[i]=String.valueOf(pm.getApplicationLabel(a))+" · "+a.packageName+(isSystemApp(a)?" [system]":"");}
        new AlertDialog.Builder(this).setTitle("Select apps").setMultiChoiceItems(labels,checked,(d,w,c)->checked[w]=c).setNegativeButton("Cancel",null).setPositiveButton("Add to transfer",(d,w)->{
            int added=0;for(int i=0;i<all.size();i++)if(checked[i])added+=exportInstalledApp(all.get(i));selectedText.setText(added+" app"+(added==1?"":"s")+" prepared for transfer");}).show();
    }
    private boolean isSystemApp(ApplicationInfo a){return (a.flags&(ApplicationInfo.FLAG_SYSTEM|ApplicationInfo.FLAG_UPDATED_SYSTEM_APP))!=0;}
    private int exportInstalledApp(ApplicationInfo app){ArrayList<Item> made=new ArrayList<>();return exportInstalledApp(app,made);}

    private boolean wifiEnabled(){
        try{WifiManager wm=(WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);return wm!=null&&wm.isWifiEnabled();}catch(Exception e){return true;}
    }
    private boolean locationEnabled(){
        if(Build.VERSION.SDK_INT<28)return true;
        try{LocationManager lm=(LocationManager)getSystemService(LOCATION_SERVICE);return lm!=null&&lm.isLocationEnabled();}catch(Exception e){return true;}
    }
    private void showSystemRequirement(String title,String message,boolean wifi){
        peerBox.removeAllViews();
        peerBox.addView(label(title,16,Color.WHITE));
        TextView body=label(message,13,Color.LTGRAY);body.setPadding(0,dp(8),0,dp(12));peerBox.addView(body);
        Button open=actionButton(wifi?"OPEN WI-FI PANEL":"OPEN LOCATION SETTINGS");
        open.setBackground(bg(Color.rgb(50,92,210),12));
        open.setOnClickListener(v->{try{
            Intent target;
            if(wifi&&Build.VERSION.SDK_INT>=29)target=new Intent(android.provider.Settings.Panel.ACTION_WIFI);
            else target=new Intent(wifi?android.provider.Settings.ACTION_WIFI_SETTINGS:android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            startActivity(target);
        }catch(Exception ignored){try{startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS));}catch(Exception ignored2){}}});
        peerBox.addView(open,new LinearLayout.LayoutParams(-1,dp(48)));
    }

    private void startTransferService(){
        try{
            Intent i=new Intent(this,AemTransferService.class);
            if(Build.VERSION.SDK_INT>=26)startForegroundService(i);else startService(i);
        }catch(Exception ignored){}
    }
    private void stopTransferService(){
        try{stopService(new Intent(this,AemTransferService.class));}catch(Exception ignored){}
    }
    private void beginTransferSession(){
        transferId=UUID.randomUUID().toString();
        transferActive=true;
        startTransferService();
        if(disconnectButton!=null)disconnectButton.setEnabled(true);
    }
    private void finishTransferSession(){
        transferActive=false;
        stopTransferService();
        if(connectionActive) runOnUiThread(()->{
            disconnectButton.setEnabled(true);
            showPostTransferOptions();
        });
    }
    private void showPostTransferOptions(){
        peerBox.removeAllViews();
        radar=null;
        TextView h=label("Transfer complete",16,Color.WHITE);
        h.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        peerBox.addView(h);
        TextView info=label("The connection is still active. Choose another item above and send again without disconnecting.",13,Color.LTGRAY);
        info.setPadding(0,dp(8),0,dp(10));
        peerBox.addView(info);
        Button more=actionButton("BACK TO ITEMS / SEND MORE");
        more.setBackground(bg(Color.rgb(50,92,210),12));
        more.setOnClickListener(v->{
            peerBox.removeAllViews();
            status.setText("Connection active • select another item, then press Send.");
            modeHint.setText("Connected transfer session: choose another item and send it without disconnecting.");
        });
        peerBox.addView(more,new LinearLayout.LayoutParams(-1,dp(48)));
    }
    private void showRadar(){
        peerBox.removeAllViews();
        radar=new RadarView(this);
        peerBox.addView(radar,new LinearLayout.LayoutParams(-1,dp(168)));
    }

    private void startReceive(){
        if(!hasPermission()){pendingAction="receive";requestPermissions(requiredPermissions(),PERM);return;}
        if(!wifiEnabled()){waitingForWifi=true;status.setText("Wi-Fi is off • turn it on, then return to AEM. Receiver setup will resume automatically.");showSystemRequirement("Wi-Fi is required","AEM Transfer uses Wi-Fi Direct for the local phone-to-phone connection.",true);return;}
        sending=false;
        modeHint.setText("Receive mode: keep this screen open. The sender will appear when nearby.");
        if(manager==null||channel==null){status.setText("Wi-Fi Direct is unavailable on this phone.");return;}
        showRadar();
        status.setText("Preparing receiver…");
        cleanupGroupThenCreate();
    }
    private void cleanupGroupThenCreate(){
        try{
            manager.removeGroup(channel,new WifiP2pManager.ActionListener(){
                public void onSuccess(){createReceiverGroup();}
                public void onFailure(int r){createReceiverGroup();}
            });
        }catch(Exception e){createReceiverGroup();}
    }
    private void createReceiverGroup(){
        manager.createGroup(channel,new WifiP2pManager.ActionListener(){
            public void onSuccess(){
                status.setText("Receiver ready • waiting for sender…");
                registerReceiverService();
                startServer();
                showConnectionGuide(false);
            }
            public void onFailure(int r){
                status.setText("Receiver setup failed ("+r+"). Tap Receive again to retry.");
                showConnectionGuide(false);
            }
        });
    }
    private void discover(){
        if(!hasPermission()){pendingAction="send";requestPermissions(requiredPermissions(),PERM);return;}
        if(!wifiEnabled()){waitingForWifi=true;status.setText("Wi-Fi is off • turn it on, then return to AEM. Scanning will resume automatically.");showSystemRequirement("Turn on Wi-Fi","AEM uses Wi-Fi Direct locally; mobile data and Internet are not used for the transfer.",true);return;}
        if(!locationEnabled()){waitingForLocation=true;status.setText("Location services are off • turn them on, then return to AEM. Scanning will resume automatically.");showSystemRequirement("Turn on Location services","Android requires Location Mode enabled for Wi-Fi Direct peer discovery on supported versions. AEM does not use your location for the transfer.",false);return;}
        modeHint.setText("Send mode: AEM is scanning for nearby receivers.");
        if(manager==null||channel==null){status.setText("Wi-Fi Direct is unavailable on this phone.");return;}
        showRadar();
        showConnectionGuide(true);
        status.setText("Scanning for nearby AEM phones…");
        try{
            manager.stopPeerDiscovery(channel,new WifiP2pManager.ActionListener(){public void onSuccess(){beginDiscovery();}public void onFailure(int r){beginDiscovery();}});
        }catch(Exception e){beginDiscovery();}
    }
    private void beginDiscovery(){
        peerNames.clear();
        prepareServiceDiscovery();
        manager.discoverPeers(channel,new WifiP2pManager.ActionListener(){
            public void onSuccess(){status.setText("Scanning… keep both phones on this screen.");}
            public void onFailure(int r){
                String msg=r==WifiP2pManager.BUSY?"Wi-Fi Direct is busy. Turn Wi-Fi off/on, then tap Send again.":"Discovery failed ("+r+").";
                status.setText(msg);
                showConnectionGuide(true);
            }
        });
    }
    private void showConnectionGuide(boolean sender){
        if(radar==null){radar=new RadarView(this);peerBox.addView(radar,new LinearLayout.LayoutParams(-1,dp(168)));}
        TextView h=label(sender?"Nearby receivers":"Waiting for a sender",15,Color.WHITE);
        h.setTypeface(Typeface.DEFAULT,Typeface.BOLD);peerBox.addView(h);
        peerBox.addView(label(sender
            ?"1. On the other phone, open AEM → Transfer → Receive."
            :"1. On the sending phone, open AEM → Transfer → Send.",13,Color.LTGRAY));
        peerBox.addView(label(sender
            ?"2. Keep Wi-Fi on and allow Nearby devices. AEM will list compatible nearby phones."
            :"2. Keep this screen open while AEM waits for the sender.",13,Color.LTGRAY));
        peerBox.addView(label(sender
            ?"3. Tap Send beside the receiver you want. Connection and transfer start automatically."
            :"3. When the sender connects, the transfer begins automatically.",13,Color.LTGRAY));
        if(sender){
            Button retry=actionButton("SCAN AGAIN");
            retry.setBackground(bg(Color.rgb(50,92,210),12));
            retry.setOnClickListener(v->discover());
            peerBox.addView(retry,new LinearLayout.LayoutParams(-1,dp(46)));
        }else{
            TextView ready=label("Receiver is ready • waiting nearby",12,Color.rgb(110,210,150));
            ready.setPadding(0,dp(8),0,dp(4));peerBox.addView(ready);
        }
    }
    private void requestPeers(){if(!hasPermission()||manager==null||channel==null)return;manager.requestPeers(channel,list->{peers.clear();peers.addAll(list.getDeviceList());renderPeers();});}
    private void renderPeers(){\n        peerBox.removeAllViews();\n        radar=new RadarView(this);\n        peerBox.addView(radar,new LinearLayout.LayoutParams(-1,dp(168)));\n        radar=new RadarView(this);\n        peerBox.addView(radar,new LinearLayout.LayoutParams(-1,dp(168)));if(peers.isEmpty()){TextView empty=label(sending?"Scanning for nearby receivers…":"No receiver found yet",15,Color.WHITE);empty.setTypeface(Typeface.DEFAULT,Typeface.BOLD);peerBox.addView(empty);if(sending){ProgressBar scan=new ProgressBar(this);scan.setIndeterminate(true);peerBox.addView(scan,new LinearLayout.LayoutParams(-1,dp(4)));peerBox.addView(label("Keep the receiver on AEM → Transfer → Receive. AEM will update this list when a compatible phone is found.",13,Color.LTGRAY));}else peerBox.addView(label("Keep the other phone on AEM → Transfer → Receive, then scan again.",13,Color.LTGRAY));if(sending){Button retry=actionButton("SCAN AGAIN");retry.setBackground(bg(Color.rgb(50,92,210),12));retry.setOnClickListener(v->discover());peerBox.addView(retry,new LinearLayout.LayoutParams(-1,dp(46)));}return;}TextView heading=label(peers.size()+" nearby device"+(peers.size()==1?"":"s"),13,Color.rgb(170,175,185));heading.setPadding(0,dp(2),0,dp(6));peerBox.addView(heading);for(WifiP2pDevice d:peers){
        LinearLayout card=new LinearLayout(this);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(14),dp(8),dp(8),dp(8));
        card.setBackground(bg(Color.rgb(25,28,35),14));
        String displayName=peerNames.get(d.deviceAddress);
        if(displayName==null||displayName.trim().isEmpty())displayName=(d.deviceName==null||d.deviceName.isEmpty()?"Nearby phone":d.deviceName);
        TextView device=label(displayName,15,Color.WHITE);
        device.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        card.addView(device,new LinearLayout.LayoutParams(0,dp(50),1));
        Button b=actionButton("Send");
        b.setBackground(bg(Color.rgb(50,92,210),12));
        card.addView(b,new LinearLayout.LayoutParams(dp(100),dp(50)));
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(66));p.setMargins(0,dp(4),0,dp(4));peerBox.addView(card,p);
        b.setOnClickListener(v->connect(d));
    }}
    private void connect(WifiP2pDevice d){if(selected.isEmpty()){status.setText("Select at least one item first.");return;}sending=true;connectedHost=null;beginTransferSession();status.setText("Connecting to "+d.deviceName+"…");WifiP2pConfig c=new WifiP2pConfig();c.deviceAddress=d.deviceAddress;c.wps.setup=WpsInfo.PBC;
        manager.connect(channel,c,new WifiP2pManager.ActionListener(){public void onSuccess(){status.setText("Connection requested...");}public void onFailure(int r){sending=false;finishTransferSession();status.setText("Connection failed: "+r);}});
    }
    private void requestConnection(){if(!hasPermission()||manager==null||channel==null)return;manager.requestConnectionInfo(channel,info->{
        if(info.groupFormed){
            connectionActive=true;
            disconnectButton.setEnabled(true);
            if(!info.isGroupOwner&&info.groupOwnerAddress!=null&&sending){
                sending=false;
                connectedHost=info.groupOwnerAddress.getHostAddress();
                io.execute(()->sendFiles(connectedHost));
            }
        }
    });}
    private void startServer(){if(server!=null&&!server.isClosed())return;io.execute(()->{try{server=new ServerSocket(PORT);while(!server.isClosed()){Socket s=server.accept();receiveFiles(s);}}catch(Exception ignored){}});}

    private long skipFully(InputStream in,long offset)throws IOException{
        long left=offset;
        while(left>0){long n=in.skip(left);if(n<=0){if(in.read()==-1)throw new EOFException("Cannot seek source");n=1;}left-=n;}
        return offset-left;
    }
    private byte[] fullSha(InputStream in)throws Exception{
        MessageDigest md=MessageDigest.getInstance("SHA-256");byte[] b=new byte[1024*1024];int n;
        while((n=in.read(b))!=-1)if(n>0)md.update(b,0,n);
        return md.digest();
    }
    private File partFile(String id,int index){File dir=new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"AEM Transfer/.resume");if(!dir.exists())dir.mkdirs();return new File(dir,id+"-"+index+".part");}
    private File doneFile(String id,int index){File dir=new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"AEM Transfer/.resume");if(!dir.exists())dir.mkdirs();return new File(dir,id+"-"+index+".done");}

    private void sendFiles(String host){
        if(transferId==null)transferId=UUID.randomUUID().toString();
        int attempt=0;
        while(transferActive&&attempt++<8){
            try(Socket s=new Socket()){
                s.setTcpNoDelay(true);s.setSendBufferSize(1024*1024);s.connect(new InetSocketAddress(host,PORT),15000);s.setSoTimeout(60000);
                DataOutputStream out=new DataOutputStream(new BufferedOutputStream(s.getOutputStream(),256*1024));
                out.writeInt(PROTOCOL);out.writeUTF(transferId);out.writeInt(selected.size());
                long total=0;for(Item x:selected)total+=x.size;out.writeLong(total);
                for(Item x:selected){byte[] nb=x.name.getBytes("UTF-8");out.writeInt(nb.length);out.write(nb);out.writeLong(x.size);}
                out.flush();
                DataInputStream ackIn=new DataInputStream(new BufferedInputStream(s.getInputStream(),64*1024));
                long[] offsets=new long[selected.size()];for(int i=0;i<offsets.length;i++)offsets[i]=ackIn.readLong();
                long done=0;for(long o:offsets)done+=o;
                SpeedMeter speed=new SpeedMeter();byte[] b=new byte[1024*1024];
                for(int i=0;i<selected.size();i++){
                    Item x=selected.get(i);long offset=Math.max(0,Math.min(offsets[i],x.size));
                    if(offset>=x.size){update("Resuming "+x.name+" · already received",percent(done,total));continue;}
                    try(InputStream in=getContentResolver().openInputStream(x.uri)){
                        if(in==null)throw new IOException("Cannot read "+x.name);
                        skipFully(in,offset);
                        long left=x.size-offset;int n;
                        MessageDigest md=MessageDigest.getInstance("SHA-256");
                        if(offset>0){
                            try(InputStream prefix=getContentResolver().openInputStream(x.uri)){
                                if(prefix==null)throw new IOException("Cannot read "+x.name);
                                byte[] pb=new byte[1024*1024];long remain=offset;int pn;
                                while(remain>0&&(pn=prefix.read(pb,0,(int)Math.min(pb.length,remain)))>0){md.update(pb,0,pn);remain-=pn;}
                            }
                        }
                        while(left>0&&(n=in.read(b,0,(int)Math.min(b.length,left)))>0){
                            out.write(b,0,n);md.update(b,0,n);left-=n;done+=n;
                            update((offset>0?"Resuming ":"Sending ")+x.name+" · "+percent(done,total)+"% · "+speed.formatRate(done),percent(done,total));
                        }
                        if(left!=0)throw new IOException("Source changed while reading "+x.name);
                        out.write(md.digest());out.flush();
                    }
                }
                int result=ackIn.readInt();
                if(result==1){update("Transfer completed and verified",100);finishTransferSession();return;}
                throw new IOException("Receiver rejected transfer");
            }catch(Exception e){
                if(!transferActive)return;
                update("Connection interrupted • resuming… (attempt "+attempt+"/8)",0);
                try{Thread.sleep(Math.min(5000L,500L*attempt));}catch(InterruptedException ie){Thread.currentThread().interrupt();break;}
            }
        }
        if(transferActive)update("Transfer stopped after repeated connection loss",0);
        finishTransferSession();
    }

    private void receiveFiles(Socket s){io.execute(()->{
        beginTransferSession();
        boolean completed=false;
        try(Socket sock=s){
            sock.setTcpNoDelay(true);sock.setReceiveBufferSize(1024*1024);sock.setSoTimeout(60000);
            DataInputStream in=new DataInputStream(new BufferedInputStream(sock.getInputStream(),256*1024));
            int protocol=in.readInt();if(protocol!=PROTOCOL)throw new IOException("Unsupported transfer protocol");
            String id=in.readUTF();if(!id.matches("[A-Za-z0-9-]{8,64}"))throw new IOException("Invalid transfer id");
            int count=in.readInt();if(count<0||count>1000)throw new IOException("Invalid item count");
            long declaredTotal=in.readLong();if(declaredTotal<0)throw new IOException("Invalid total size");
            ArrayList<Header> hs=new ArrayList<>();long total=0;
            for(int i=0;i<count;i++){
                int nl=in.readInt();if(nl<1||nl>16384)throw new IOException("Invalid file name");
                byte[] nb=new byte[nl];in.readFully(nb);String name=safePath(new String(nb,"UTF-8"));long size=in.readLong();if(size<0)throw new IOException("Invalid file size");
                hs.add(new Header(name,size,null));total+=size;if(total<0||total>declaredTotal)throw new IOException("Invalid transfer size");
            }
            long[] offsets=new long[count];
            for(int i=0;i<count;i++){
                File done=doneFile(id,i),part=partFile(id,i);
                if(done.exists()){offsets[i]=hs.get(i).size;continue;}
                File expectedTarget=new File(new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"AEM Transfer"),hs.get(i).name);
                if(!part.exists() && expectedTarget.isFile() && expectedTarget.length()==hs.get(i).size){
                    if(done.createNewFile() || done.exists()){offsets[i]=hs.get(i).size;continue;}
                }
                long len=part.exists()?part.length():0;
                if(len>hs.get(i).size){part.delete();len=0;}
                offsets[i]=len;
            }
            DataOutputStream control=new DataOutputStream(new BufferedOutputStream(sock.getOutputStream(),64*1024));
            for(long o:offsets)control.writeLong(o);control.flush();
            File dir=new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"AEM Transfer");
            if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cannot create transfer folder");
            long doneBytes=0;for(long o:offsets)doneBytes+=o;
            byte[] b=new byte[1024*1024];SpeedMeter speed=new SpeedMeter();
            for(int i=0;i<hs.size();i++){
                Header h=hs.get(i);if(offsets[i]>=h.size)continue;
                File part=partFile(id,i);
                try(OutputStream out=new BufferedOutputStream(new FileOutputStream(part,true),256*1024)){
                    long left=h.size-offsets[i];int n;
                    while(left>0){n=in.read(b,0,(int)Math.min(b.length,left));if(n<0)throw new IOException("Connection ended");if(n==0)continue;out.write(b,0,n);left-=n;doneBytes+=n;update("Receiving "+h.name+" · "+percent(doneBytes,total)+"% · "+speed.formatRate(doneBytes),percent(doneBytes,total));}
                }
                byte[] expected=new byte[32];in.readFully(expected);
                byte[] actual;try(FileInputStream fin=new FileInputStream(part)){actual=fullSha(fin);}
                if(!Arrays.equals(expected,actual))throw new IOException("Integrity check failed for "+h.name);
                File target=unique(new File(dir,h.name));File parent=target.getParentFile();if(parent!=null&&!parent.exists()&&!parent.mkdirs())throw new IOException("Cannot create destination folder");
                if(!part.renameTo(target))throw new IOException("Cannot finalize "+h.name);
                File done=doneFile(id,i);if(!done.createNewFile()&&!done.exists())throw new IOException("Cannot persist resume state");
            }
            control.writeInt(1);control.flush();
            update("Transfer received and verified successfully",100);
            for(int i=0;i<count;i++){partFile(id,i).delete();doneFile(id,i).delete();}
            completed=true;
        }catch(Exception e){
            try{DataOutputStream ack=new DataOutputStream(new BufferedOutputStream(s.getOutputStream(),64*1024));ack.writeInt(0);ack.flush();}catch(Exception ignored){}
            update("Connection interrupted • partial data saved for resume",0);
        }finally{
            if(completed)finishTransferSession();
        }
    });}
    private static final class Header{String name;long size;byte[] hash;Header(String n,long s,byte[] h){name=n;size=s;hash=h;}}
    private byte[] sha256(Item x)throws Exception{MessageDigest md=MessageDigest.getInstance("SHA-256");try(InputStream in=getContentResolver().openInputStream(x.uri)){if(in==null)throw new IOException("Cannot read "+x.name);byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)if(n>0)md.update(b,0,n);}return md.digest();}
    private String safePath(String n){n=n.replace('\\','/').replace('\0','_').replaceAll("^[\\/]+","");String[] p=n.split("/");StringBuilder b=new StringBuilder();for(String x:p){x=x.replaceAll("[\\:*?\"<>|]","_").trim();if(x.isEmpty()||x.equals(".")||x.equals(".."))continue;if(b.length()>0)b.append(File.separator);b.append(x);}return b.length()==0?"AEM-file":b.toString();}
    private File unique(File f){if(!f.exists())return f;String n=f.getName();int dot=n.lastIndexOf('.');String b=dot>0?n.substring(0,dot):n,e=dot>0?n.substring(dot):"";int i=1;File x;do{x=new File(f.getParentFile(),b+" ("+(i++)+")"+e);}while(x.exists());return x;}
    private void disconnectTransfer(){
        sending=false;
        transferActive=false;
        connectionActive=false;
        connectedHost=null;
        transferId=null;
        stopTransferService();
        try{if(server!=null)server.close();}catch(Exception ignored){}
        try{
            if(manager!=null&&channel!=null){
                manager.removeGroup(channel,new WifiP2pManager.ActionListener(){
                    public void onSuccess(){status.setText("Disconnected. Wi-Fi remains available.");}
                    public void onFailure(int r){status.setText("Disconnected.");}
                });
            }else status.setText("Disconnected.");
        }catch(Exception e){status.setText("Disconnected.");}
        if(disconnectButton!=null)disconnectButton.setEnabled(false);
    }

    private int percent(long d,long t){return t>0?(int)Math.max(0,Math.min(100,d*100/t)):0;}
    private String safe(Exception e){String m=e.getMessage();return m==null?"connection interrupted":m;}
    private void update(String text,int pct){runOnUiThread(()->{status.setText(text);progress.setProgress(pct);});}
    @Override protected void onDestroy(){try{unregisterReceiver(receiver);}catch(Exception ignored){}if(!transferActive){try{if(server!=null)server.close();}catch(Exception ignored){}try{if(manager!=null&&channel!=null)manager.removeGroup(channel,new WifiP2pManager.ActionListener(){public void onSuccess(){}public void onFailure(int r){}});}catch(Exception ignored){}io.shutdownNow();}super.onDestroy();}
}