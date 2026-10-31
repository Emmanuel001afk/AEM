package com.aem.store;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.net.wifi.WpsInfo;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo;
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest;
import android.net.wifi.p2p.WifiP2pGroup;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.LruCache;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * AEM Transfer: direct phone-to-phone transfer over Wi-Fi Direct.
 *
 * The screen is a first-class part of the AEM Store experience: same palette, type
 * scale, card language and section navigation. The wire protocol is deliberately
 * small and defensive: a handshake token is required before any bytes flow, the
 * receiver explicitly accepts the transfer, every file is verified with SHA-256,
 * and interrupted transfers resume from the receiver's reported offsets.
 */
public class AemTransferActivity extends Activity {
    private static final int PORT = 38177;
    private static final int PROTOCOL = 6;
    private static final int PERM_NEARBY = 7001;
    private static final int PERM_MEDIA = 7002;
    private static final int PERM_NOTIFICATIONS = 7003;
    private static final int REQ_FILES = 7010;
    private static final int REQ_FOLDER = 7011;

    private static final int MATCH = ViewGroup.LayoutParams.MATCH_PARENT;
    private static final int WRAP = ViewGroup.LayoutParams.WRAP_CONTENT;

    private static final String PREFS = "aem_transfer";
    private static final String HISTORY_PREFS = "aem_transfer_history";
    private static final String HISTORY_KEY = "items";
    private static final String TRANSFER_FOLDER = "AEM Transfer";
    private static final String ACTION_INSTALL_STATUS = "com.aem.store.AEM_TRANSFER_INSTALL";

    private static final long MAX_ITEM_BYTES = 50L * 1024L * 1024L * 1024L;
    private static final long MAX_TOTAL_BYTES = 200L * 1024L * 1024L * 1024L;
    private static final int MAX_ITEMS = 2000;

    private static final int TONE_ACCENT = 0;
    private static final int TONE_SUCCESS = 1;
    private static final int TONE_WARNING = 2;
    private static final int TONE_DANGER = 3;

    // ------------------------------------------------------------------ state

    private boolean lightTheme = false;
    private boolean uiBuilt = false;
    private SharedPreferences prefs;

    private String section = "Transfer";           // Transfer | Downloads | History
    private String category = "Apps";               // Apps | Photos | Videos | Music | Files
    private volatile boolean receiveMode = false;
    private volatile boolean nearby = false;        // discovery screen
    private volatile boolean scanning = false;
    private volatile boolean receivePreparing = false;
    private volatile boolean receiving = false;
    private volatile boolean receiveArmed = false;
    private volatile boolean connected = false;

    private volatile boolean senderRole = false;
    private volatile String activeHost = null;
    private volatile String remoteName = null;
    private volatile String remoteToken = null;
    private volatile String localToken = null;
    private volatile String senderToken = null;
    private volatile String transferId = null;

    private final AtomicBoolean sendingNow = new AtomicBoolean(false);
    private final AtomicBoolean sessionActive = new AtomicBoolean(false);
    private volatile boolean connectPending = false;
    private volatile boolean sendAborted = false;
    private Runnable activeTransferCancel = null;

    private final ArrayList<Item> selected = new ArrayList<>();
    private final HashSet<String> selectedKeys = new HashSet<>();
    private final HashSet<String> exporting = new HashSet<>();

    private final ArrayList<AppEntry> installedApps = new ArrayList<>();
    private long installedAppsAt = 0L;
    private String appQuery = "";
    private EditText appSearch;
    private LinearLayout appRows;

    private String pendingPermissionAction = null;   // send | receive
    private String pendingMediaCategory = null;
    private boolean waitingForWifi = false;
    private boolean waitingForLocation = false;

    private final LinkedHashMap<String, Peer> peers = new LinkedHashMap<>();
    private Runnable peerRefreshRunnable;
    private Runnable discoveryLoop;
    private WifiP2pManager.PeerListListener peerListListener;
    private static final long DISCOVERY_INTERVAL_MS = 2800L;
    private final ArrayList<ActiveReceive> activeReceives = new ArrayList<>();

    private static final class ActiveReceive {
        String sender;
        long total;
        long done;
        int count;
        long startedAt;
        boolean completed;
    }

    private final LruCache<String, Bitmap> thumbnails = new LruCache<String, Bitmap>(32 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap value) { return value.getByteCount(); }
    };

    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Set<Socket> openSockets = Collections.synchronizedSet(new HashSet<Socket>());
    private final AtomicBoolean incomingBusy = new AtomicBoolean(false);
    private final Object serverLock = new Object();

    private WifiP2pManager p2p;
    private WifiP2pManager.Channel p2pChannel;
    private BroadcastReceiver p2pReceiver;
    private BroadcastReceiver installReceiver;
    private WifiP2pDnsSdServiceInfo localService;
    private WifiP2pDnsSdServiceRequest serviceRequest;
    private ServerSocket server;

    private volatile String acceptedTransferId = null;
    private volatile String acceptedHost = null;
    private AlertDialog incomingDialog;
    private File pendingInstall = null;
    private String installingName = null;

    // fixed chrome
    private FrameLayout page;
    private LinearLayout column;
    private LinearLayout tabsBar;
    private LinearLayout banner;
    private LinearLayout bannerRow;
    private View bannerDot;
    private TextView bannerTitle;
    private TextView bannerDetail;
    private TextView bannerAction;
    private ProgressBar bannerProgress;
    private ScrollView contentScroll;
    private LinearLayout content;
    private LinearLayout bottomBar;
    private TextView bottomSummary;
    private TextView bottomSend;
    private TextView bottomClear;
    private TextView bottomReview;
    private TextView headerTitle;
    private TextView headerSubtitle;

    private int bannerToken = 0;
    private long lastProgressPaint = 0L;
    private int mediaGeneration = 0;
    private Runnable appFilterRunnable;

    // ------------------------------------------------------------------ models

    private static final class Item {
        final String key;
        final String path;
        final long size;
        final Uri uri;
        final File file;

        private Item(String key, String path, long size, Uri uri, File file) {
            this.key = key;
            this.path = path;
            this.size = Math.max(0L, size);
            this.uri = uri;
            this.file = file;
        }

        static Item fromUri(Uri uri, String path, long size) {
            return new Item("uri:" + uri, path, size, uri, null);
        }

        static Item fromFile(File file, String path) {
            return new Item("file:" + file.getAbsolutePath(), path, file.length(), null, file);
        }

        String label() {
            int slash = path.lastIndexOf('/');
            return slash < 0 ? path : path.substring(slash + 1);
        }

        String extension() {
            String name = label();
            int dot = name.lastIndexOf('.');
            return dot < 0 || dot == name.length() - 1 ? "" : name.substring(dot + 1).toLowerCase(Locale.US);
        }
    }

    private static final class AppEntry {
        final String packageName;
        final String label;
        final Drawable icon;
        final boolean system;

        AppEntry(String packageName, String label, Drawable icon, boolean system) {
            this.packageName = packageName;
            this.label = label;
            this.icon = icon;
            this.system = system;
        }
    }

    private static final class Peer {
        final String address;
        final String name;
        final String token;
        final boolean compatible;

        Peer(String address, String name, String token, boolean compatible) {
            this.address = address;
            this.name = name;
            this.token = token;
            this.compatible = compatible;
        }
    }

    private static final class Header {
        final String path;
        final long size;

        Header(String path, long size) {
            this.path = path;
            this.size = size;
        }
    }

    private static final class FatalTransferException extends IOException {
        private static final long serialVersionUID = 1L;
        FatalTransferException(String message) { super(message); }
    }

    private static final class SpeedMeter {
        private long lastBytes = 0L;
        private long lastNanos = System.nanoTime();
        private double rate = 0d;

        String update(long bytes) {
            long now = System.nanoTime();
            long elapsed = now - lastNanos;
            if (elapsed < 250_000_000L) return label();
            double delta = Math.max(0d, (double) (bytes - lastBytes));
            double instant = delta * 1_000_000_000d / Math.max(1L, elapsed);
            rate = rate <= 0d ? instant : rate * 0.65d + instant * 0.35d;
            lastBytes = bytes;
            lastNanos = now;
            return label();
        }

        String label() {
            if (rate < 1024d * 512d) return String.format(Locale.US, "%.0f KB/s", rate / 1024d);
            if (rate < 1024d * 1024d * 1024d) return String.format(Locale.US, "%.1f MB/s", rate / (1024d * 1024d));
            return String.format(Locale.US, "%.2f GB/s", rate / (1024d * 1024d * 1024d));
        }
    }

    // ------------------------------------------------------------------ lifecycle

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        initTheme(getIntent());
        configureWindow();
        buildUi();
        initP2p();
        registerInstallReceiver();
        pruneResumeFiles();
        render();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent == null) return;
        String appearance = intent.getStringExtra("appearance");
        if (appearance == null) return;
        boolean nextLight = "light".equalsIgnoreCase(appearance);
        if (nextLight != lightTheme) {
            lightTheme = nextLight;
            buildUi();
            render();
        }
    }

    private void initTheme(Intent intent) {
        String appearance = intent == null ? null : intent.getStringExtra("appearance");
        if ("light".equalsIgnoreCase(appearance)) lightTheme = true;
        else if ("dark".equalsIgnoreCase(appearance)) lightTheme = false;
        else {
            int mode = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            lightTheme = mode == android.content.res.Configuration.UI_MODE_NIGHT_NO;
        }
        if (prefs != null) prefs.edit().putBoolean("light", lightTheme).apply();
    }

    private void configureWindow() {
        getWindow().getDecorView().setBackgroundColor(pageColor());
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(lightTheme ? mask : 0, mask);
            }
        } else {
            getWindow().setStatusBarColor(pageColor());
            getWindow().setNavigationBarColor(pageColor());
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
            if (lightTheme) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (pendingInstall != null && canInstallPackages()) {
            File file = pendingInstall;
            pendingInstall = null;
            installPackage(file);
        }
        if (waitingForWifi && wifiEnabled()) {
            waitingForWifi = false;
            if ("send".equals(pendingPermissionAction) || nearby) startSendFlow();
            else if (receiveMode) startReceivingFlow();
        } else if (waitingForLocation && locationEnabled()) {
            waitingForLocation = false;
            if (nearby) startSendFlow();
        }
        updateBottomBar();
    }

    @Override protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        try { if (p2pReceiver != null) unregisterReceiver(p2pReceiver); } catch (Exception ignored) { }
        try { if (installReceiver != null) unregisterReceiver(installReceiver); } catch (Exception ignored) { }
        // A real config change keeps the link alive (the manifest also pins configChanges);
        // any other destruction must release the group, the socket and the foreground service.
        if (!isChangingConfigurations()) {
            teardownLink();
            io.shutdownNow();
        }
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onDestroy();
    }

    private void teardownLink() {
        sessionActive.set(false);
        sendingNow.set(false);
        connectPending = false;
        closeServer();
        cancelDiscoveryLoop();
        localToken = null;
        remoteToken = null;
        connected = false;
        receiving = false;
        receivePreparing = false;
        try { if (p2p != null && p2pChannel != null) p2p.stopPeerDiscovery(p2pChannel, noop()); } catch (Exception ignored) { }
        try { if (p2p != null && p2pChannel != null && serviceRequest != null) p2p.removeServiceRequest(p2pChannel, serviceRequest, noop()); } catch (Exception ignored) { }
        try { if (p2p != null && p2pChannel != null) p2p.clearServiceRequests(p2pChannel, noop()); } catch (Exception ignored) { }
        try { if (p2p != null && p2pChannel != null && localService != null) p2p.removeLocalService(p2pChannel, localService, noop()); } catch (Exception ignored) { }
        try { if (p2p != null && p2pChannel != null) p2p.removeGroup(p2pChannel, noop()); } catch (Exception ignored) { }
        AemTransferService.stop(this);
    }

    private WifiP2pManager.ActionListener noop() {
        return new WifiP2pManager.ActionListener() {
            @Override public void onSuccess() { }
            @Override public void onFailure(int reason) { }
        };
    }

    // ------------------------------------------------------------------ palette

    private int pageColor() { return lightTheme ? Color.rgb(243, 243, 245) : Color.rgb(9, 9, 12); }
    private int accent() { return Color.rgb(240, 68, 68); }
    private int accentSoft() { return lightTheme ? Color.rgb(198, 42, 48) : Color.rgb(255, 138, 138); }
    private int ink() { return lightTheme ? Color.rgb(18, 18, 22) : Color.rgb(245, 245, 247); }
    private int secondary() { return lightTheme ? Color.rgb(92, 97, 108) : Color.rgb(170, 175, 185); }
    private int muted() { return lightTheme ? Color.rgb(112, 117, 128) : Color.rgb(132, 137, 148); }
    private int cardColor() { return lightTheme ? Color.WHITE : Color.argb(20, 255, 255, 255); }
    private int cardBorder() { return lightTheme ? Color.argb(26, 18, 18, 22) : Color.argb(32, 255, 255, 255); }
    private int sunken() { return lightTheme ? Color.argb(12, 18, 18, 22) : Color.argb(16, 255, 255, 255); }
    private int sunkenBorder() { return lightTheme ? Color.argb(18, 18, 18, 22) : Color.argb(22, 255, 255, 255); }
    private int success() { return lightTheme ? Color.rgb(20, 132, 84) : Color.rgb(76, 195, 138); }
    private int warning() { return lightTheme ? Color.rgb(166, 102, 8) : Color.rgb(245, 180, 80); }
    private int danger() { return lightTheme ? Color.rgb(198, 42, 48) : Color.rgb(255, 107, 107); }
    private int toneColor(int tone) {
        if (tone == TONE_SUCCESS) return success();
        if (tone == TONE_WARNING) return warning();
        if (tone == TONE_DANGER) return danger();
        return accentSoft();
    }

    private int withAlpha(int color, int alpha) {
        return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color));
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private int strokeWidth() {
        return Math.max(1, (int) (getResources().getDisplayMetrics().density + 0.5f));
    }

    private Drawable rounded(int color, float radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        return shape;
    }

    private Drawable rounded(int color, float radius, int borderColor) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        shape.setStroke(strokeWidth(), borderColor);
        return shape;
    }

    private Drawable cardBackground(float radius) {
        return rounded(cardColor(), radius, cardBorder());
    }

    private Drawable ripple(Drawable content, int rippleColor) {
        return new RippleDrawable(ColorStateList.valueOf(rippleColor), content, null);
    }

    private Typeface bold() { return Typeface.create(Typeface.DEFAULT, Typeface.BOLD); }

    private TextView text(String value, float sizeSp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTextColor(color);
        return view;
    }

    private TextView heading(String value, float sizeSp) {
        TextView view = text(value, sizeSp, ink());
        view.setTypeface(bold());
        view.setLetterSpacing(-0.02f);
        return view;
    }

    private TextView eyebrow(String value) {
        TextView view = text(value.toUpperCase(Locale.US), 10f, secondary());
        view.setTypeface(bold());
        view.setLetterSpacing(0.16f);
        return view;
    }

    private TextView body(String value) {
        TextView view = text(value, 13f, secondary());
        view.setLineSpacing(dp(3), 1f);
        return view;
    }

    private TextView pill(String label, boolean primary, int heightDp) {
        TextView view = text(label, 13f, primary ? Color.WHITE : ink());
        view.setTypeface(bold());
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(heightDp));
        view.setPadding(dp(16), dp(4), dp(14), dp(4));
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(primary ? accent() : sunken());
        shape.setCornerRadius(dp(heightDp >= 44 ? 14 : 12));
        if (!primary) shape.setStroke(strokeWidth(), sunkenBorder());
        view.setBackground(ripple(shape, primary ? withAlpha(Color.WHITE, 60) : withAlpha(ink(), 28)));
        view.setClickable(true);
        view.setFocusable(true);
        return view;
    }

    private TextView link(String label) {
        TextView view = text(label, 13f, accentSoft());
        view.setTypeface(bold());
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(dp(6), dp(8), dp(6), dp(8));
        view.setClickable(true);
        view.setFocusable(true);
        return view;
    }

    private TextView tile(String label, int background, int foreground) {
        TextView view = text(label, 15f, foreground);
        view.setTypeface(bold());
        view.setGravity(Gravity.CENTER);
        view.setBackground(rounded(background, 16));
        return view;
    }

    private View spacer(int heightDp) {
        View view = new View(this);
        view.setLayoutParams(new LinearLayout.LayoutParams(MATCH, dp(heightDp)));
        return view;
    }

    private View flexibleSpace() {
        View view = new View(this);
        view.setLayoutParams(new LinearLayout.LayoutParams(0, 1, 1f));
        return view;
    }

    private View divider() {
        View view = new View(this);
        view.setBackgroundColor(withAlpha(ink(), lightTheme ? 18 : 26));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(MATCH, Math.max(1, strokeWidth()));
        params.setMargins(0, dp(8), 0, dp(8));
        view.setLayoutParams(params);
        return view;
    }

    // ------------------------------------------------------------------ shell UI

    private void buildUi() {
        configureWindow();
        page = new FrameLayout(this);
        page.addView(new Backdrop(this), new FrameLayout.LayoutParams(MATCH, MATCH));

        column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        if (Build.VERSION.SDK_INT >= 30) {
            column.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                    android.graphics.Insets bars = insets.getInsets(
                            WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    view.setPadding(dp(18), bars.top + dp(6), dp(18), bars.bottom + dp(10));
                    return insets;
                }
            });
        } else {
            column.setPadding(dp(18), dp(14), dp(18), dp(12));
        }

        column.addView(buildHeader());
        column.addView(buildBanner());
        column.addView(buildTabs());

        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(0, dp(12), 0, dp(20));
        contentScroll = new ScrollView(this);
        contentScroll.setFillViewport(true);
        contentScroll.setClipToPadding(false);
        contentScroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        contentScroll.addView(content, new ScrollView.LayoutParams(MATCH, WRAP));
        column.addView(contentScroll, new LinearLayout.LayoutParams(MATCH, 0, 1f));

        column.addView(buildBottomBar());

        page.addView(column, new FrameLayout.LayoutParams(MATCH, MATCH));
        setContentView(page);
        uiBuilt = true;
    }

    private View buildHeader() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(0, dp(8), 0, dp(6));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView mark = text("A", 19f, Color.WHITE);
        mark.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(rounded(accent(), 11));
        LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(34), dp(34));
        markParams.setMargins(0, 0, dp(12), 0);
        row.addView(mark, markParams);

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        headerTitle = heading("Transfer", 23f);
        headerSubtitle = text("Phone to phone · no cloud", 11f, secondary());
        headerSubtitle.setPadding(0, dp(2), 0, 0);
        titles.addView(headerTitle);
        titles.addView(headerSubtitle);
        row.addView(titles, new LinearLayout.LayoutParams(0, WRAP, 1f));

        TextView close = text("×", 26f, ink());
        close.setGravity(Gravity.CENTER);
        close.setBackground(ripple(rounded(sunken(), 20, sunkenBorder()), withAlpha(ink(), 30)));
        close.setContentDescription("Close transfer");
        close.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { finishWithConfirmation(); }
        });
        row.addView(close, new LinearLayout.LayoutParams(dp(38), dp(38)));

        header.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));
        return header;
    }

    private View buildBanner() {
        banner = new LinearLayout(this);
        banner.setOrientation(LinearLayout.VERTICAL);
        banner.setPadding(dp(14), dp(11), dp(12), dp(11));
        banner.setVisibility(View.GONE);
        LinearLayout.LayoutParams bannerParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        bannerParams.setMargins(0, dp(6), 0, dp(2));
        banner.setLayoutParams(bannerParams);

        bannerRow = new LinearLayout(this);
        bannerRow.setGravity(Gravity.CENTER_VERTICAL);

        bannerDot = new View(this);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(8), dp(8));
        dotParams.setMargins(0, 0, dp(10), 0);
        bannerRow.addView(bannerDot, dotParams);

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        bannerTitle = text("", 13f, ink());
        bannerTitle.setTypeface(bold());
        bannerDetail = text("", 11.5f, secondary());
        bannerDetail.setPadding(0, dp(2), 0, 0);
        texts.addView(bannerTitle);
        texts.addView(bannerDetail);
        bannerRow.addView(texts, new LinearLayout.LayoutParams(0, WRAP, 1f));

        bannerAction = text("", 12f, accentSoft());
        bannerAction.setTypeface(bold());
        bannerAction.setPadding(dp(10), dp(6), dp(4), dp(6));
        bannerAction.setVisibility(View.GONE);
        bannerAction.setClickable(true);
        bannerRow.addView(bannerAction, new LinearLayout.LayoutParams(WRAP, WRAP));

        banner.addView(bannerRow, new LinearLayout.LayoutParams(MATCH, WRAP));

        bannerProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bannerProgress.setMax(100);
        bannerProgress.setProgressTintList(ColorStateList.valueOf(accent()));
        bannerProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(MATCH, dp(4));
        progressParams.setMargins(0, dp(10), 0, dp(1));
        banner.addView(bannerProgress, progressParams);
        return banner;
    }

    private View buildTabs() {
        tabsBar = new LinearLayout(this);
        tabsBar.setOrientation(LinearLayout.HORIZONTAL);
        tabsBar.setPadding(dp(4), dp(4), dp(4), dp(4));
        tabsBar.setBackground(rounded(lightTheme ? Color.argb(14, 18, 18, 22) : Color.argb(18, 255, 255, 255), 15, cardBorder()));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(MATCH, dp(44));
        params.setMargins(0, dp(8), 0, 0);
        tabsBar.setLayoutParams(params);
        return tabsBar;
    }

    private View buildBottomBar() {
        bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.VERTICAL);
        bottomBar.setPadding(dp(14), dp(11), dp(12), dp(11));
        bottomBar.setBackground(cardBackground(18));
        bottomBar.setVisibility(View.GONE);
        LinearLayout.LayoutParams outer = new LinearLayout.LayoutParams(MATCH, WRAP);
        outer.setMargins(0, dp(6), 0, 0);
        bottomBar.setLayoutParams(outer);

        bottomSummary = text("", 12.5f, secondary());
        bottomSummary.setTypeface(bold());
        bottomSummary.setTextColor(ink());
        bottomBar.addView(bottomSummary, new LinearLayout.LayoutParams(MATCH, WRAP));

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(0, dp(8), 0, 0);

        bottomReview = pill("Review", false, 38);
        bottomReview.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { showSelectionDialog(); }
        });
        actions.addView(bottomReview, new LinearLayout.LayoutParams(WRAP, dp(38)));

        actions.addView(flexibleSpace(), new LinearLayout.LayoutParams(0, 1, 1f));

        bottomClear = link("Clear");
        bottomClear.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { clearSelection(); }
        });
        actions.addView(bottomClear, new LinearLayout.LayoutParams(WRAP, dp(38)));

        bottomSend = pill("Send", true, 40);
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(WRAP, dp(40));
        sendParams.setMargins(dp(6), 0, 0, 0);
        bottomSend.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { startSendFlow(); }
        });
        actions.addView(bottomSend, sendParams);

        bottomBar.addView(actions, new LinearLayout.LayoutParams(MATCH, WRAP));
        return bottomBar;
    }

    // ------------------------------------------------------------------ render

    private void updateHeader() {
        if (headerTitle == null) return;
        if ("Downloads".equals(section)) {
            headerTitle.setText("Downloads");
            headerSubtitle.setText("Received files · open, install, share");
        } else if ("History".equals(section)) {
            headerTitle.setText("History");
            headerSubtitle.setText("What was sent and received");
        } else {
            headerTitle.setText("Transfer");
            headerSubtitle.setText("Phone to phone · no cloud");
        }
    }

    private void updateTabs() {
        if (tabsBar == null) return;
        tabsBar.removeAllViews();
        String[] names = {"Transfer", "Downloads", "History"};
        for (int index = 0; index < names.length; index++) {
            final String name = names[index];
            boolean active = name.equals(section);
            TextView cell = text(name, 12.5f, active ? Color.WHITE : secondary());
            cell.setTypeface(bold());
            cell.setGravity(Gravity.CENTER);
            if (active) cell.setBackground(rounded(accent(), 12));
            else cell.setBackground(ripple(rounded(Color.TRANSPARENT, 12), withAlpha(ink(), 20)));
            cell.setClickable(true);
            cell.setFocusable(true);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(36), 1f);
            params.setMargins(dp(1), 0, dp(1), 0);
            tabsBar.addView(cell, params);
            cell.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { showSection(name); }
            });
        }
    }

    private void showSection(String name) {
        if (name.equals(section)) return;
        if (!"Transfer".equals(name) && (scanning || nearby)) {
            stopDiscovery();
            nearby = false;
            scanning = false;
        }
        section = name;
        render();
    }

    private void render() {
        if (!uiBuilt || content == null) return;
        updateHeader();
        updateTabs();
        appSearch = null;
        appRows = null;
        content.removeAllViews();
        if ("Downloads".equals(section)) {
            renderDownloads();
        } else if ("History".equals(section)) {
            renderHistory();
        } else if (nearby) {
            renderNearby();
        } else if (receiveMode) {
            renderReceive();
        } else {
            renderPicker();
        }
        updateBottomBar();
    }

    private void updateBottomBar() {
        if (bottomBar == null) return;
        boolean show = "Transfer".equals(section) && !receiveMode && !nearby && !selected.isEmpty();
        bottomBar.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) return;
        long total = 0L;
        for (Item item : selected) total += item.size;
        bottomSummary.setText(selected.size() + (selected.size() == 1 ? " item selected · " : " items selected · ") + format(total));
        bottomSend.setText(connected ? "Send now" : "Send");
    }

    private void clearSelection() {
        selected.clear();
        selectedKeys.clear();
        if ("Apps".equals(category) && appRows != null) renderAppRows();
        updateBottomBar();
        toast("Selection cleared");
    }

    private boolean isSelected(String key) {
        return selectedKeys.contains(key);
    }

    private void addItem(Item item) {
        if (item == null || selectedKeys.contains(item.key)) return;
        selectedKeys.add(item.key);
        selected.add(item);
    }

    private void removeItem(Item item) {
        selectedKeys.remove(item.key);
        selected.remove(item);
    }

    private void removeItemByKey(String key) {
        Iterator<Item> iterator = selected.iterator();
        while (iterator.hasNext()) {
            if (iterator.next().key.equals(key)) iterator.remove();
        }
        selectedKeys.remove(key);
    }

    // presentational helpers used by the section renderers -------------------

    private LinearLayout card() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(dp(16), dp(14), dp(16), dp(14));
        view.setBackground(cardBackground(20));
        return view;
    }

    private void addCard(View view) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(MATCH, WRAP);
        params.setMargins(0, 0, 0, dp(10));
        content.addView(view, params);
    }

    private void addSectionLabel(String label) {
        TextView view = eyebrow(label);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(MATCH, WRAP);
        params.setMargins(dp(2), dp(8), 0, dp(8));
        content.addView(view, params);
    }

    private void addEmptyState(String glyph, String title, String detail) {
        LinearLayout card = card();
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(22), dp(26), dp(22), dp(24));
        TextView icon = tile(glyph, withAlpha(accentSoft(), lightTheme ? 22 : 30), accentSoft());
        card.addView(icon, new LinearLayout.LayoutParams(dp(46), dp(46)));
        TextView heading = heading(title, 16f);
        heading.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        headingParams.setMargins(0, dp(12), 0, dp(6));
        card.addView(heading, headingParams);
        TextView detailView = body(detail);
        detailView.setGravity(Gravity.CENTER);
        card.addView(detailView, new LinearLayout.LayoutParams(MATCH, WRAP));
        addCard(card);
    }

    private TextView chip(String label, boolean active) {
        TextView view = text(label, 12.5f, active ? Color.WHITE : ink());
        view.setTypeface(bold());
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(14), dp(8), dp(14), dp(8));
        if (active) view.setBackground(rounded(accent(), 20));
        else view.setBackground(ripple(rounded(lightTheme ? Color.argb(12, 18, 18, 22) : Color.argb(16, 255, 255, 255), 20, cardBorder()), withAlpha(ink(), 20)));
        view.setClickable(true);
        view.setFocusable(true);
        return view;
    }

    private void addDeviceRow(LinearLayout parent) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(2), 0, dp(2));
        TextView dot = text("●", 10f, success());
        row.addView(dot);
        TextView name = text("This device · " + deviceName(), 11.5f, secondary());
        name.setPadding(dp(6), 0, 0, 0);
        row.addView(name, new LinearLayout.LayoutParams(0, WRAP, 1f));
        TextView edit = link("Edit");
        edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        edit.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { showRenameDialog(); }
        });
        row.addView(edit);
        parent.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));
    }

    // ------------------------------------------------------------------ banner

    private int dialogSurface() {
        return lightTheme ? Color.WHITE : Color.rgb(24, 26, 32);
    }

    /**
     * Android's stock dialog theme follows the system, not the Store's appearance
     * toggle. Re-style the window and text so transfer dialogs never flash a
     * bright white panel over the dark AEM screen (or the reverse).
     */
    private void styleDialog(AlertDialog dialog) {
        if (dialog == null) return;
        try {
            android.view.Window window = dialog.getWindow();
            if (window != null) {
                window.setBackgroundDrawable(rounded(dialogSurface(), 20, cardBorder()));
                window.setDimAmount(0.5f);
            }
        } catch (Exception ignored) { }
        try {
            int titleId = getResources().getIdentifier("alertTitle", "id", "android");
            TextView title = titleId == 0 ? null : dialog.findViewById(titleId);
            if (title != null) title.setTextColor(ink());
            TextView message = dialog.findViewById(android.R.id.message);
            if (message != null) {
                message.setTextColor(secondary());
                message.setLineSpacing(dp(3), 1f);
            }
            TextView positive = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            if (positive != null) positive.setTextColor(accentSoft());
            TextView negative = dialog.getButton(AlertDialog.BUTTON_NEGATIVE);
            if (negative != null) negative.setTextColor(muted());
            TextView neutral = dialog.getButton(AlertDialog.BUTTON_NEUTRAL);
            if (neutral != null) neutral.setTextColor(muted());
        } catch (Exception ignored) { }
    }

    private AlertDialog showDialog(AlertDialog dialog) {
        dialog.show();
        styleDialog(dialog);
        return dialog;
    }

    private void showBanner(String title, String detail, int tone, int autoHideMs) {
        showBanner(title, detail, tone, autoHideMs, null, null);
    }

    private void showBanner(String title, String detail, int tone, int autoHideMs, String actionLabel, final Runnable action) {
        if (banner == null) return;
        final int localToken = ++bannerToken;
        int color = toneColor(tone);
        banner.setVisibility(View.VISIBLE);
        banner.setBackground(rounded(withAlpha(color, lightTheme ? 20 : 26), 16, withAlpha(color, 90)));
        bannerDot.setBackground(rounded(color, 4));
        bannerTitle.setText(title);
        bannerDetail.setText(detail == null ? "" : detail);
        bannerDetail.setVisibility(detail == null || detail.isEmpty() ? View.GONE : View.VISIBLE);
        bannerProgress.setVisibility(View.GONE);
        if (actionLabel != null && action != null) {
            bannerAction.setVisibility(View.VISIBLE);
            bannerAction.setText(actionLabel);
            bannerAction.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { action.run(); }
            });
        } else {
            bannerAction.setVisibility(View.GONE);
            bannerAction.setOnClickListener(null);
        }
        if (autoHideMs > 0) {
            ui.postDelayed(new Runnable() {
                @Override public void run() {
                    if (bannerToken == localToken) hideBanner();
                }
            }, autoHideMs);
        }
    }

    private void showTransferBanner(String title, String detail, int percent, boolean determinate) {
        if (banner == null) return;
        bannerToken++;
        banner.setVisibility(View.VISIBLE);
        banner.setBackground(rounded(withAlpha(accent(), lightTheme ? 20 : 24), 16, withAlpha(accent(), 90)));
        bannerDot.setBackground(rounded(accent(), 4));
        bannerTitle.setText(title);
        bannerDetail.setText(detail == null ? "" : detail);
        bannerDetail.setVisibility(View.VISIBLE);
        bannerProgress.setVisibility(View.VISIBLE);
        bannerProgress.setIndeterminate(!determinate);
        bannerProgress.setProgress(Math.max(0, Math.min(100, percent)));
        if (activeTransferCancel != null) {
            bannerAction.setVisibility(View.VISIBLE);
            bannerAction.setText("Cancel");
            bannerAction.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) {
                    Runnable cancel = activeTransferCancel;
                    if (cancel != null) cancel.run();
                }
            });
        } else {
            bannerAction.setVisibility(View.GONE);
            bannerAction.setOnClickListener(null);
        }
    }

    private void hideBanner() {
        if (banner == null) return;
        bannerToken++;
        banner.setVisibility(View.GONE);
        bannerProgress.setVisibility(View.GONE);
    }

    // ------------------------------------------------------------------ backdrop

    private final class Backdrop extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        Backdrop(Context context) { super(context); }

        @Override protected void onDraw(Canvas canvas) {
            int width = getWidth();
            int height = getHeight();
            canvas.drawColor(pageColor());
            if (lightTheme || width <= 0 || height <= 0) return;
            RadialGradient glow = new RadialGradient(
                    width * 0.78f, 0f,
                    Math.max(width, height) * 0.44f,
                    new int[]{Color.rgb(41, 27, 36), Color.rgb(9, 9, 12)},
                    new float[]{0f, 1f},
                    Shader.TileMode.CLAMP);
            paint.setShader(glow);
            paint.setStyle(Paint.Style.FILL);
            canvas.drawRect(0, 0, width, height, paint);
        }
    }

    // ------------------------------------------------------------------ picker

    private void renderPicker() {
        if (connected) addConnectedCard();

        addModeCards();

        LinearLayout deviceCard = card();
        deviceCard.setPadding(dp(14), dp(8), dp(10), dp(8));
        addDeviceRow(deviceCard);
        addCard(deviceCard);

        addSectionLabel("What to send");
        addCategoryChips();

        if ("Apps".equals(category)) renderAppsSection();
        else if ("Files".equals(category)) renderFilesSection();
        else renderMediaSection();

        if (selected.isEmpty()) {
            LinearLayout hint = card();
            hint.setPadding(dp(14), dp(11), dp(14), dp(11));
            hint.setBackground(rounded(sunken(), 16, sunkenBorder()));
            TextView line = text("Pick files or apps above, then tap Send. Nothing leaves this phone unless you choose it.", 11.5f, secondary());
            line.setLineSpacing(dp(2), 1f);
            hint.addView(line);
            addCard(hint);
        }
    }

    private void addConnectedCard() {
        LinearLayout card = card();
        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        View dot = new View(this);
        dot.setBackground(rounded(success(), 4));
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(8), dp(8));
        dotParams.setMargins(0, 0, dp(9), 0);
        head.addView(dot, dotParams);
        TextView state = text("Connected", 11f, success());
        state.setTypeface(bold());
        state.setLetterSpacing(0.1f);
        head.addView(state);
        card.addView(head);

        TextView name = heading(remoteName == null ? "Nearby phone" : remoteName, 17f);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        nameParams.setMargins(0, dp(6), 0, dp(4));
        card.addView(name, nameParams);
        card.addView(body("The link stays open. Add more items and send again without reconnecting."));

        LinearLayout rowActions = new LinearLayout(this);
        rowActions.setOrientation(LinearLayout.HORIZONTAL);
        rowActions.setPadding(0, dp(10), 0, 0);
        TextView disconnect = pill("Disconnect", false, 38);
        disconnect.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { disconnectLink(); }
        });
        rowActions.addView(disconnect, new LinearLayout.LayoutParams(WRAP, dp(38)));
        TextView swap = pill("Swap & Receive", false, 38);
        swap.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { swapLinkDirection(); }
        });
        LinearLayout.LayoutParams swapParams = new LinearLayout.LayoutParams(WRAP, dp(38));
        swapParams.setMargins(dp(8), 0, 0, 0);
        rowActions.addView(swap, swapParams);
        card.addView(rowActions, new LinearLayout.LayoutParams(MATCH, WRAP));
        TextView hint = text("Stay connected to send more, or Swap so they can send to you without repairing.", 10.5f, muted());
        hint.setPadding(0, dp(6), 0, 0);
        card.addView(hint);
        addCard(card);
    }

    private void addModeCards() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);

        LinearLayout send = modeCard("↑", "Send", "Pick what to share", !receiveMode, new Runnable() {
            @Override public void run() {
                if (receiveMode && (receiving || receivePreparing)) stopReceivingFlow(false);
                receiveMode = false;
                render();
            }
        });
        LinearLayout receive = modeCard("↓", "Receive", "Be visible nearby", receiveMode, new Runnable() {
            @Override public void run() {
                if (!receiveMode) {
                    if (scanning || nearby) { stopDiscovery(); nearby = false; scanning = false; }
                    receiveMode = true;
                    render();
                }
            }
        });

        LinearLayout.LayoutParams left = new LinearLayout.LayoutParams(0, WRAP, 1f);
        left.setMargins(0, 0, dp(5), 0);
        LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(0, WRAP, 1f);
        right.setMargins(dp(5), 0, 0, 0);
        row.addView(send, left);
        row.addView(receive, right);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(MATCH, WRAP);
        params.setMargins(0, 0, 0, dp(10));
        content.addView(row, params);
    }

    private LinearLayout modeCard(String glyph, String title, String detail, boolean active, final Runnable onClick) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(13), dp(14), dp(13));
        card.setMinimumHeight(dp(108));
        if (active) card.setBackground(rounded(withAlpha(accent(), lightTheme ? 16 : 22), 20, withAlpha(accent(), 130)));
        else card.setBackground(cardBackground(20));
        card.setClickable(true);
        card.setFocusable(true);

        TextView icon = tile(glyph, active ? accent() : sunken(), active ? Color.WHITE : ink());
        card.addView(icon, new LinearLayout.LayoutParams(dp(34), dp(34)));

        TextView titleView = heading(title, 16f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(WRAP, WRAP);
        titleParams.setMargins(0, dp(9), 0, dp(2));
        card.addView(titleView, titleParams);

        TextView detailView = text(detail, 11.5f, active ? ink() : secondary());
        card.addView(detailView, new LinearLayout.LayoutParams(WRAP, WRAP));

        card.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { onClick.run(); }
        });
        return card;
    }

    private void addCategoryChips() {
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setClipToPadding(false);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(1), 0, dp(1), 0);
        String[] categories = {"Apps", "Photos", "Videos", "Music", "Files"};
        for (int index = 0; index < categories.length; index++) {
            final String value = categories[index];
            TextView view = chip(value, value.equals(category));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(WRAP, WRAP);
            params.setMargins(0, 0, dp(7), 0);
            row.addView(view, params);
            view.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View target) {
                    if (value.equals(category)) return;
                    category = value;
                    appQuery = "";
                    render();
                }
            });
        }
        scroll.addView(row, new HorizontalScrollView.LayoutParams(WRAP, WRAP));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(MATCH, WRAP);
        params.setMargins(0, 0, 0, dp(10));
        content.addView(scroll, params);
    }

    // ---- installed apps ----------------------------------------------------

    private void renderAppsSection() {
        LinearLayout holder = card();
        holder.setPadding(dp(14), dp(13), dp(14), dp(10));

        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.addView(eyebrow("Installed apps"), new LinearLayout.LayoutParams(0, WRAP, 1f));
        TextView count = text(installedApps.isEmpty() ? "" : installedApps.size() + " apps", 10.5f, muted());
        head.addView(count);
        holder.addView(head);

        appSearch = new EditText(this);
        appSearch.setSingleLine(true);
        appSearch.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        appSearch.setTextColor(ink());
        appSearch.setHintTextColor(muted());
        appSearch.setHint("Search this phone");
        appSearch.setText(appQuery);
        if (appQuery.length() > 0) appSearch.setSelection(appQuery.length());
        appSearch.setPadding(dp(12), 0, dp(12), 0);
        appSearch.setBackground(rounded(sunken(), 12, sunkenBorder()));
        appSearch.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(MATCH, dp(42));
        searchParams.setMargins(0, dp(10), 0, dp(6));
        holder.addView(appSearch, searchParams);

        appRows = new LinearLayout(this);
        appRows.setOrientation(LinearLayout.VERTICAL);
        appRows.addView(body("Reading installed apps…"));
        holder.addView(appRows, new LinearLayout.LayoutParams(MATCH, WRAP));

        appSearch.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                appQuery = text == null ? "" : text.toString();
                if (appFilterRunnable != null) ui.removeCallbacks(appFilterRunnable);
                appFilterRunnable = new Runnable() {
                    @Override public void run() { renderAppRows(); }
                };
                ui.postDelayed(appFilterRunnable, 150L);
            }
            @Override public void afterTextChanged(Editable editable) { }
        });

        addCard(holder);

        boolean stale = System.currentTimeMillis() - installedAppsAt > 60_000L;
        if (stale) loadInstalledApps();
        else {
            count.setText(installedApps.size() + " apps");
            renderAppRows();
        }
    }

    private void loadInstalledApps() {
        final long startedAt = System.currentTimeMillis();
        io.execute(new Runnable() {
            @Override public void run() {
                final ArrayList<AppEntry> found = new ArrayList<>();
                try {
                    PackageManager pm = getPackageManager();
                    List<ApplicationInfo> infos = pm.getInstalledApplications(PackageManager.GET_META_DATA);
                    for (int index = 0; index < infos.size(); index++) {
                        ApplicationInfo info = infos.get(index);
                        if (info == null || getPackageName().equals(info.packageName)) continue;
                        String label;
                        try { label = String.valueOf(pm.getApplicationLabel(info)); }
                        catch (Exception error) { label = info.packageName; }
                        Drawable icon;
                        try { icon = pm.getApplicationIcon(info); }
                        catch (Exception error) { icon = null; }
                        boolean system = (info.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
                        found.add(new AppEntry(info.packageName, label, icon, system));
                        if (found.size() >= 600) break;
                    }
                    Collections.sort(found, new Comparator<AppEntry>() {
                        @Override public int compare(AppEntry left, AppEntry right) {
                            if (left.system != right.system) return left.system ? 1 : -1;
                            return left.label.compareToIgnoreCase(right.label);
                        }
                    });
                } catch (Exception ignored) { }
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        installedApps.clear();
                        installedApps.addAll(found);
                        installedAppsAt = startedAt;
                        if (appRows != null && "Apps".equals(category) && "Transfer".equals(section) && !nearby && !receiveMode) {
                            renderAppRows();
                        }
                    }
                });
            }
        });
    }

    private void renderAppRows() {
        if (appRows == null || !"Apps".equals(category) || !"Transfer".equals(section) || nearby || receiveMode) return;
        appRows.removeAllViews();
        String query = appQuery == null ? "" : appQuery.trim().toLowerCase(Locale.US);
        int shown = 0;
        for (int index = 0; index < installedApps.size(); index++) {
            final AppEntry entry = installedApps.get(index);
            if (!query.isEmpty()
                    && !entry.label.toLowerCase(Locale.US).contains(query)
                    && !entry.packageName.toLowerCase(Locale.US).contains(query)) continue;
            appRows.addView(appRow(entry), new LinearLayout.LayoutParams(MATCH, WRAP));
            shown++;
            if (shown >= 250) break;
        }
        if (shown == 0) {
            TextView empty = body(installedApps.isEmpty() ? "No installed apps were found." : "No apps match “" + appQuery + "”.");
            empty.setPadding(dp(2), dp(12), 0, dp(12));
            appRows.addView(empty);
        }
    }

    private View appRow(final AppEntry entry) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(8), dp(8), dp(8));
        row.setBackground(ripple(rounded(sunken(), 14, sunkenBorder()), withAlpha(ink(), 18)));
        row.setClickable(true);
        row.setFocusable(true);

        ImageView icon = new ImageView(this);
        icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        if (entry.icon != null) icon.setImageDrawable(entry.icon);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(38), dp(38));
        iconParams.setMargins(0, 0, dp(10), 0);
        row.addView(icon, iconParams);

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView label = text(entry.label, 13.5f, ink());
        label.setTypeface(bold());
        label.setSingleLine(true);
        label.setEllipsize(TextUtils.TruncateAt.END);
        TextView meta = text(entry.packageName + (entry.system ? " · system" : ""), 10f, muted());
        meta.setSingleLine(true);
        meta.setEllipsize(TextUtils.TruncateAt.END);
        texts.addView(label);
        texts.addView(meta);
        row.addView(texts, new LinearLayout.LayoutParams(0, WRAP, 1f));

        final TextView check = selectionIndicator("pkg:" + entry.packageName, exporting.contains(entry.packageName));
        row.addView(check, new LinearLayout.LayoutParams(dp(30), dp(30)));

        row.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { toggleApp(entry, check); }
        });
        return row;
    }

    private TextView selectionIndicator(String key, boolean busy) {
        TextView view = text("", 13f, Color.WHITE);
        view.setTypeface(bold());
        view.setGravity(Gravity.CENTER);
        boolean checked = isSelected(key);
        if (checked) {
            view.setText("✓");
            view.setBackground(rounded(accent(), 15));
        } else {
            view.setText(busy ? "…" : "");
            view.setBackground(rounded(Color.TRANSPARENT, 15, busy ? withAlpha(accent(), 90) : cardBorder()));
        }
        return view;
    }

    private void toggleApp(final AppEntry entry, final TextView indicator) {
        String key = "pkg:" + entry.packageName;
        if (isSelected(key)) {
            removeItemByKey(key);
            indicator.setText("");
            indicator.setBackground(rounded(Color.TRANSPARENT, 15, cardBorder()));
            updateBottomBar();
            return;
        }
        if (exporting.contains(entry.packageName)) {
            toast("Still preparing " + entry.label);
            return;
        }
        exporting.add(entry.packageName);
        indicator.setText("…");
        showBanner("Preparing " + entry.label, "Building a transferable package from this phone", TONE_ACCENT, 0);
        io.execute(new Runnable() {
            @Override public void run() {
                final Item item = exportApp(entry);
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        exporting.remove(entry.packageName);
                        if (item != null) {
                            addItem(item);
                            hideBanner();
                            toast(entry.label + " ready to send");
                        } else {
                            showBanner("Could not prepare " + entry.label,
                                    "This app may not allow its package to be read on this phone.",
                                    TONE_DANGER, 6000);
                        }
                        if (appRows != null) renderAppRows();
                        updateBottomBar();
                    }
                });
            }
        });
    }

    private Item exportApp(AppEntry entry) {
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(entry.packageName, 0);
            ArrayList<String> paths = new ArrayList<>();
            if (info.sourceDir != null) paths.add(info.sourceDir);
            if (info.splitSourceDirs != null) Collections.addAll(paths, info.splitSourceDirs);
            if (paths.isEmpty()) return null;

            File dir = new File(getCacheDir(), "aem-apps");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File output = new File(dir, entry.packageName + ".apks");
            File meta = new File(dir, entry.packageName + ".meta");

            StringBuilder fingerprint = new StringBuilder();
            for (int index = 0; index < paths.size(); index++) {
                File source = new File(paths.get(index));
                if (!source.isFile() || !source.canRead()) continue;
                fingerprint.append(source.getAbsolutePath()).append('|')
                        .append(source.length()).append('|')
                        .append(source.lastModified()).append('\n');
            }
            String signature = fingerprint.toString();
            String wireName = entry.label.replace('/', '_').replace('\\', '_') + ".apks";
            if (output.isFile() && output.length() > 0 && meta.isFile() && signature.equals(readText(meta))) {
                return Item.fromFile(output, wireName);
            }

            File temp = new File(dir, entry.packageName + ".apks.tmp");
            try (ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(temp), 1024 * 1024))) {
                byte[] buffer = new byte[1024 * 1024];
                int component = 0;
                for (int index = 0; index < paths.size(); index++) {
                    File source = new File(paths.get(index));
                    if (!source.isFile() || !source.canRead()) continue;
                    String name = component == 0 ? "base.apk" : "split-" + component + ".apk";
                    component++;
                    zip.putNextEntry(new ZipEntry(name));
                    try (InputStream in = new BufferedInputStream(new FileInputStream(source), 1024 * 1024)) {
                        int read;
                        while ((read = in.read(buffer)) != -1) if (read > 0) zip.write(buffer, 0, read);
                    }
                    zip.closeEntry();
                }
                if (component == 0) throw new IOException("No readable package components");
            }
            if (output.exists() && !output.delete()) throw new IOException("Could not replace cached package");
            if (!temp.renameTo(output)) throw new IOException("Could not finalize cached package");
            writeText(meta, signature);
            return Item.fromFile(output, wireName);
        } catch (Exception error) {
            return null;
        }
    }

    // ---- media -------------------------------------------------------------

    private void renderMediaSection() {
        final int generation = ++mediaGeneration;
        final String mediaCategory = category;

        LinearLayout holder = card();
        holder.setPadding(dp(14), dp(13), dp(14), dp(12));
        holder.addView(eyebrow("On this phone"));

        final LinearLayout rows = new LinearLayout(this);
        rows.setOrientation(LinearLayout.VERTICAL);
        TextView loading = body("Reading " + mediaCategory.toLowerCase(Locale.US) + "…");
        loading.setPadding(0, dp(10), 0, dp(8));
        rows.addView(loading);
        holder.addView(rows, new LinearLayout.LayoutParams(MATCH, WRAP));
        addCard(holder);

        if (!hasMediaPermission(mediaCategory)) {
            rows.removeAllViews();
            TextView explain = body("AEM needs permission to list " + mediaCategory.toLowerCase(Locale.US)
                    + " here. You can still use Files to pick individual items.");
            explain.setPadding(0, dp(8), 0, dp(6));
            rows.addView(explain);
            TextView allow = pill("Allow access", true, 40);
            allow.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) {
                    pendingMediaCategory = mediaCategory;
                    requestPermissions(new String[]{permissionToRequest(mediaCategory)}, PERM_MEDIA);
                }
            });
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(WRAP, dp(40));
            params.setMargins(0, dp(4), 0, 0);
            rows.addView(allow, params);
            return;
        }

        io.execute(new Runnable() {
            @Override public void run() {
                final ArrayList<Item> found = queryMedia(mediaCategory);
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (generation != mediaGeneration || !"Transfer".equals(section) || !mediaCategory.equals(category)) return;
                        rows.removeAllViews();
                        if (found.isEmpty()) {
                            TextView empty = body("No " + mediaCategory.toLowerCase(Locale.US) + " found on this phone.");
                            empty.setPadding(0, dp(10), 0, dp(8));
                            rows.addView(empty);
                            return;
                        }
                        for (int index = 0; index < found.size(); index++) {
                            rows.addView(mediaRow(found.get(index), mediaCategory), new LinearLayout.LayoutParams(MATCH, WRAP));
                        }
                    }
                });
            }
        });
    }

    private View mediaRow(final Item item, final String mediaCategory) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(6), dp(6), dp(8), dp(6));
        row.setBackground(ripple(rounded(sunken(), 14, sunkenBorder()), withAlpha(ink(), 18)));
        row.setClickable(true);
        row.setFocusable(true);

        ImageView thumb = new ImageView(this);
        thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
        thumb.setBackground(rounded(withAlpha(accentSoft(), lightTheme ? 24 : 34), 11));
        LinearLayout.LayoutParams thumbParams = new LinearLayout.LayoutParams(dp(52), dp(52));
        thumbParams.setMargins(0, 0, dp(10), 0);
        row.addView(thumb, thumbParams);
        loadThumbnail(thumb, item);

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView name = text(item.label(), 13.5f, ink());
        name.setTypeface(bold());
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        texts.addView(name);
        texts.addView(text(format(item.size) + " · " + mediaCategory, 10.5f, muted()));
        row.addView(texts, new LinearLayout.LayoutParams(0, WRAP, 1f));

        final TextView check = selectionIndicator(item.key, false);
        row.addView(check, new LinearLayout.LayoutParams(dp(30), dp(30)));

        row.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                if (isSelected(item.key)) {
                    removeItem(item);
                    check.setText("");
                    check.setBackground(rounded(Color.TRANSPARENT, 15, cardBorder()));
                } else {
                    addItem(item);
                    check.setText("✓");
                    check.setBackground(rounded(accent(), 15));
                }
                updateBottomBar();
            }
        });
        return row;
    }

    private ArrayList<Item> queryMedia(String mediaCategory) {
        ArrayList<Item> items = new ArrayList<>();
        Uri base;
        if ("Photos".equals(mediaCategory)) base = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        else if ("Videos".equals(mediaCategory)) base = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        else base = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;

        String[] projection = {
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE
        };
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(base, projection, null, null, MediaStore.MediaColumns.DATE_ADDED + " DESC");
            if (cursor == null) return items;
            int idColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
            int nameColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
            int sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
            while (cursor.moveToNext() && items.size() < 200) {
                long id = cursor.getLong(idColumn);
                String name = cursor.getString(nameColumn);
                long size = cursor.isNull(sizeColumn) ? 0L : cursor.getLong(sizeColumn);
                if (name == null || name.trim().isEmpty()) name = mediaCategory + " " + (items.size() + 1);
                items.add(Item.fromUri(ContentUris.withAppendedId(base, id), name, size));
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return items;
    }

    private void loadThumbnail(final ImageView view, final Item item) {
        Bitmap cached = thumbnails.get(item.key);
        if (cached != null) {
            view.setImageBitmap(cached);
            return;
        }
        if (Build.VERSION.SDK_INT < 29) return;
        io.execute(new Runnable() {
            @Override public void run() {
                try {
                    final Bitmap bitmap = getContentResolver().loadThumbnail(item.uri, new Size(160, 160), null);
                    if (bitmap == null) return;
                    thumbnails.put(item.key, bitmap);
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            if (view.getParent() != null) view.setImageBitmap(bitmap);
                        }
                    });
                } catch (Exception ignored) { }
            }
        });
    }

    // ---- files -------------------------------------------------------------

    private void renderFilesSection() {
        LinearLayout holder = card();
        holder.addView(eyebrow("Files & folders"));
        TextView explain = body("Documents, photos, archives, APKs and whole folders. Folder structure is kept on the other phone.");
        explain.setPadding(0, dp(8), 0, dp(12));
        holder.addView(explain);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);

        TextView files = pill("Choose files", true, 42);
        files.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { pickFiles(); }
        });
        TextView folder = pill("Choose folder", false, 42);
        folder.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { pickFolder(); }
        });
        LinearLayout.LayoutParams left = new LinearLayout.LayoutParams(0, dp(42), 1f);
        left.setMargins(0, 0, dp(5), 0);
        LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(0, dp(42), 1f);
        right.setMargins(dp(5), 0, 0, 0);
        actions.addView(files, left);
        actions.addView(folder, right);
        holder.addView(actions, new LinearLayout.LayoutParams(MATCH, WRAP));
        addCard(holder);

        if (selected.isEmpty()) {
            LinearLayout note = card();
            note.setBackground(rounded(sunken(), 16, sunkenBorder()));
            note.setPadding(dp(14), dp(11), dp(14), dp(11));
            note.addView(text("Selected files appear in Review at the bottom. Nothing is uploaded to a server.", 11.5f, secondary()));
            addCard(note);
        }
    }

    // ---- receive -----------------------------------------------------------

    private void renderReceive() {
        if (!wifiReady()) {
            addRequirementCard(false);
            addReceiveSteps();
            addModeSwitch("Switch to Send", new Runnable() {
                @Override public void run() {
                    receiveMode = false;
                    render();
                }
            });
            return;
        }

        LinearLayout card = card();
        card.addView(eyebrow("Receive mode"));
        TextView title = heading(receiving ? "Visible to nearby phones" : "Be ready to receive", 20f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        titleParams.setMargins(0, dp(7), 0, dp(6));
        card.addView(title, titleParams);
        card.addView(body(receiving
                ? "Keep AEM open or leave it running in the background. A sender can now find this phone."
                : "This phone becomes discoverable on Wi-Fi Direct. Files land in Downloads/AEM Transfer."));

        TextView stateRow = text("", 12f, secondary());
        stateRow.setPadding(0, dp(12), 0, dp(4));
        if (receiving) {
            stateRow.setText("●  Listening as " + deviceName());
            stateRow.setTextColor(success());
            card.addView(stateRow);
            if (connected) {
                TextView peer = text("Connected to " + (remoteName == null ? "a nearby phone" : remoteName), 12f, accentSoft());
                peer.setPadding(0, dp(4), 0, 0);
                card.addView(peer);
            }
        } else if (receivePreparing) {
            stateRow.setText("Preparing the local link…");
            card.addView(stateRow);
            ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            progress.setIndeterminate(true);
            progress.setProgressTintList(ColorStateList.valueOf(accent()));
            LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(MATCH, dp(4));
            progressParams.setMargins(0, dp(10), 0, 0);
            card.addView(progress, progressParams);
        } else {
            stateRow.setText("Not visible right now");
            card.addView(stateRow);
        }

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(12), 0, 0);

        TextView primary = pill(receiving || receivePreparing ? "Stop receiving" : "Start receiving",
                !(receiving || receivePreparing), 42);
        primary.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                if (receiving || receivePreparing) stopReceivingFlow(true);
                else startReceivingFlow();
            }
        });
        actions.addView(primary, new LinearLayout.LayoutParams(0, dp(42), 1f));
        if (receiving && connected) {
            TextView swap = pill("Swap → Send", false, 42);
            swap.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { swapLinkDirection(); }
            });
            LinearLayout.LayoutParams swapParams = new LinearLayout.LayoutParams(WRAP, dp(42));
            swapParams.setMargins(dp(8), 0, 0, 0);
            actions.addView(swap, swapParams);
        }
        card.addView(actions, new LinearLayout.LayoutParams(MATCH, WRAP));
        if (receiving) {
            TextView tip = text("Connected phone can now send to you. Use Swap so you can send back without repairing.", 10.5f, muted());
            tip.setPadding(0, dp(6), 0, 0);
            card.addView(tip);
        }
        addCard(card);

        addDeviceCard();
        addReceiveSteps();
        addModeSwitch("Switch to Send", new Runnable() {
            @Override public void run() {
                if (receiving || receivePreparing) stopReceivingFlow(false);
                receiveMode = false;
                render();
            }
        });
    }

    private void addReceiveSteps() {
        LinearLayout steps = card();
        steps.addView(eyebrow("How it works"));
        String[] lines = {
                "1. Start receiving on this phone.",
                "2. On the other phone, open Transfer → Send.",
                "3. Pick this device from the nearby list.",
                "4. Accept the transfer when AEM asks."
        };
        for (int index = 0; index < lines.length; index++) {
            TextView line = text(lines[index], 12.5f, secondary());
            line.setPadding(0, dp(index == 0 ? 9 : 5), 0, 0);
            steps.addView(line);
        }
        addCard(steps);
    }

    private void addModeSwitch(String label, final Runnable action) {
        TextView back = link(label);
        back.setGravity(Gravity.CENTER);
        back.setPadding(0, dp(12), 0, dp(4));
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { action.run(); }
        });
        content.addView(back, new LinearLayout.LayoutParams(MATCH, WRAP));
    }

    private void addDeviceCard() {
        LinearLayout card = card();
        card.setPadding(dp(14), dp(8), dp(10), dp(8));
        addDeviceRow(card);
        addCard(card);
    }

    private void showDiscoveryHelp() {
        String msg = "Discovery checklist (Tecno Spark 3 ↔ Infinix Smart 8):\n\n"
                + "• Both phones: Wi-Fi ON (no need to be on same Wi-Fi network).\n"
                + "• Infinix Smart 8 (Android 13): grant Nearby devices when asked.\n"
                + "• Tecno Spark 3 (Android 8–12): swipe down → Location ON + grant Location permission.\n"
                + "• One phone: Transfer → Receive → Start receiving (shows Listening).\n"
                + "• Other phone: Transfer → pick at least one file → Send → Nearby phones (wait 5–10s).\n"
                + "• Keep phones <1 m apart, screens ON, battery saver OFF.\n"
                + "• If still not found: turn Wi-Fi OFF→ON on both, retry. XOS/HiOS may delay 5–15s first time.\n"
                + "• Legacy devices appear as Wi-Fi Direct device — tap Send to try even without AEM record.";
        AlertDialog d = new AlertDialog.Builder(this).setTitle("Discovery help").setMessage(msg)
                .setPositiveButton("OK", null).create();
        showDialog(d);
    }

    private void addRequirementCard(boolean sender) {
        boolean wifi = wifiEnabled();
        boolean location = Build.VERSION.SDK_INT >= 33 || locationEnabled();
        LinearLayout card = card();
        card.addView(eyebrow("Before you continue"));
        TextView title = heading(!wifi ? "Wi-Fi is off" : "Location is off", 17f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        titleParams.setMargins(0, dp(6), 0, dp(5));
        card.addView(title, titleParams);
        card.addView(body(!wifi
                ? "Wi-Fi Direct uses Wi-Fi to build the direct link. Turn Wi-Fi on, then try again."
                : "Android below 13 requires Location to be ON for Wi-Fi Direct discovery (Tecno/Infinix: swipe down → Location). Turn it on, then try again. On Infinix Smart 8 (Android 13) this is not needed — only Nearby permission."));

        TextView action = pill(!wifi ? "Open Wi-Fi settings" : "Open location settings", true, 42);
        action.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                if (!wifi) {
                    waitingForWifi = true;
                    openWifiSettings();
                } else {
                    waitingForLocation = true;
                    openLocationSettings();
                }
            }
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(MATCH, dp(42));
        params.setMargins(0, dp(12), 0, 0);
        card.addView(action, params);

        TextView again = link("Check again");
        again.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                if (wifiReady()) {
                    if (sender) startSendFlow();
                    else startReceivingFlow();
                } else {
                    toast(!wifi ? "Wi-Fi is still off" : "Location is still off");
                    render();
                }
            }
        });
        card.addView(again, new LinearLayout.LayoutParams(WRAP, WRAP));
        addCard(card);
    }

    // ---- nearby ------------------------------------------------------------

    private void renderNearby() {
        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView back = link("‹  Transfer");
        back.setPadding(dp(2), dp(6), dp(8), dp(6));
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                stopDiscovery();
                nearby = false;
                scanning = false;
                render();
            }
        });
        top.addView(back, new LinearLayout.LayoutParams(WRAP, WRAP));
        top.addView(flexibleSpace(), new LinearLayout.LayoutParams(0, 1, 1f));
        TextView again = link("Scan again");
        again.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { startSendFlow(); }
        });
        top.addView(again, new LinearLayout.LayoutParams(WRAP, WRAP));
        LinearLayout.LayoutParams topParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        topParams.setMargins(0, 0, 0, dp(4));
        content.addView(top, topParams);

        content.addView(heading("Nearby phones", 23f), new LinearLayout.LayoutParams(MATCH, WRAP));
        TextView sub = body("Choose the phone that is showing Receive in AEM. Both phones stay on this screen during the transfer.");
        sub.setPadding(0, dp(5), 0, dp(12));
        content.addView(sub);

        if (!wifiReady()) {
            addRequirementCard(true);
            return;
        }

        LinearLayout radarCard = card();
        radarCard.setPadding(dp(14), dp(12), dp(14), dp(12));
        RadarView radar = new RadarView(this);
        radarCard.addView(radar, new LinearLayout.LayoutParams(MATCH, dp(168)));
        TextView status = text(scanning ? "Looking for nearby phones…" : "Scanning paused", 12f, scanning ? accentSoft() : secondary());
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(6), 0, 0);
        radarCard.addView(status, new LinearLayout.LayoutParams(MATCH, WRAP));
        addCard(radarCard);

        if (selected.isEmpty()) {
            LinearLayout hint = card();
            hint.setBackground(rounded(withAlpha(warning(), 16), 14, withAlpha(warning(), 80)));
            hint.setPadding(dp(14), dp(10), dp(14), dp(10));
            hint.addView(eyebrow("Pick files first"));
            hint.addView(body("You can scan now to test visibility, but pick apps/photos/files on Transfer before tapping Send on a phone."));
            hint.addView(spacer(4));
            TextView go = pill("Go to Transfer", false, 36);
            go.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { nearby = false; scanning = false; stopDiscovery(); render(); }
            });
            LinearLayout.LayoutParams goParams = new LinearLayout.LayoutParams(WRAP, dp(36));
            goParams.setMargins(0, dp(6), 0, 0);
            hint.addView(go, goParams);
            addCard(hint);
        }
        if (peers.isEmpty()) {
            LinearLayout waiting = card();
            waiting.addView(eyebrow("No phones yet"));
            TextView title = heading("Make the other phone visible", 16f);
            LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(MATCH, WRAP);
            titleParams.setMargins(0, dp(6), 0, dp(6));
            waiting.addView(title, titleParams);
            waiting.addView(body("On the other phone, open AEM → Transfer → Receive → Start receiving. Keep both phones <1 meter apart, screens on, and Wi-Fi ON.\n\nStill nothing? On Tecno Spark 3 (Android 8–12) swipe down → Location ON is mandatory. On Infinix Smart 8 (Android 13) grant Nearby devices when asked. Then tap Scan again here."));
            TextView retry = pill("Scan again", true, 42);
            retry.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { startSendFlow(); }
            });
            LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(MATCH, dp(42));
            retryParams.setMargins(0, dp(12), 0, 0);
            waiting.addView(retry, retryParams);
            TextView diag = link("Troubleshoot discovery");
            diag.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { showDiscoveryHelp(); }
            });
            waiting.addView(diag, new LinearLayout.LayoutParams(WRAP, WRAP));
            addCard(waiting);
        } else {
            addSectionLabel(peers.size() == 1 ? "1 phone found" : peers.size() + " phones found");
            ArrayList<Peer> list = new ArrayList<>(peers.values());
            for (int index = 0; index < list.size(); index++) {
                final Peer peer = list.get(index);
                addCard(peerCard(peer));
            }
        }

        content.addView(spacer(2));
        TextView stop = pill("Stop scanning", false, 42);
        stop.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                stopDiscovery();
                nearby = false;
                scanning = false;
                render();
            }
        });
        content.addView(stop, new LinearLayout.LayoutParams(MATCH, dp(42)));
    }

    private View peerCard(final Peer peer) {
        LinearLayout card = card();
        card.setPadding(dp(14), dp(12), dp(12), dp(12));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView icon = tile("↑", withAlpha(accent(), lightTheme ? 20 : 26), accentSoft());
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(38), dp(38));
        iconParams.setMargins(0, 0, dp(11), 0);
        row.addView(icon, iconParams);

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView name = text(peer.name, 14.5f, ink());
        name.setTypeface(bold());
        texts.addView(name);
        boolean isFallback = peer.token == null || peer.token.isEmpty();
        TextView meta = text(isFallback ? "Wi-Fi Direct device · tap to try (no AEM record yet)" : (peer.compatible ? "AEM Transfer · ready" : "Needs a matching AEM version"), 10.5f, isFallback ? warning() : (peer.compatible ? success() : warning()));
        texts.addView(meta);
        row.addView(texts, new LinearLayout.LayoutParams(0, WRAP, 1f));

        TextView send = pill(peer.compatible ? "Send" : "Unavailable", peer.compatible, 36);
        send.setEnabled(peer.compatible);
        if (!peer.compatible) send.setAlpha(0.6f);
        send.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { connectToPeer(peer); }
        });
        row.addView(send, new LinearLayout.LayoutParams(WRAP, dp(36)));

        card.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));
        if (isFallback) {
            TextView hint = text("This phone appeared via Wi-Fi Direct but AEM hasn't seen its transfer record yet. Make sure the other phone shows Receive → Listening, then Scan again.", 10.5f, secondary());
            hint.setPadding(0, dp(8), 0, 0);
            card.addView(hint);
        }
        return card;
    }

    private final class RadarView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private boolean attached = false;

        RadarView(Context context) { super(context); }

        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            attached = true;
        }

        @Override protected void onDetachedFromWindow() {
            attached = false;
            super.onDetachedFromWindow();
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float centerX = getWidth() / 2f;
            float centerY = getHeight() / 2f;
            float radius = Math.min(getWidth(), getHeight()) * 0.35f;

            int ringColor = lightTheme ? Color.argb(40, 18, 18, 22) : Color.argb(38, 255, 255, 255);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(1));
            paint.setShader(null);
            paint.setColor(ringColor);
            for (int index = 1; index <= 3; index++) canvas.drawCircle(centerX, centerY, radius * index / 3f, paint);
            canvas.drawLine(centerX - radius, centerY, centerX + radius, centerY, paint);
            canvas.drawLine(centerX, centerY - radius, centerX, centerY + radius, paint);

            paint.setStyle(Paint.Style.FILL);
            paint.setColor(accent());
            canvas.drawCircle(centerX, centerY, dp(4), paint);

            if (scanning) {
                double sweep = (System.currentTimeMillis() % 2400L) / 2400d * Math.PI * 2d;
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(dp(2));
                paint.setColor(withAlpha(accent(), 170));
                canvas.drawArc(centerX - radius, centerY - radius, centerX + radius, centerY + radius,
                        (float) Math.toDegrees(sweep), 52f, false, paint);
            }

            ArrayList<Peer> found = new ArrayList<>(peers.values());
            for (int index = 0; index < found.size(); index++) {
                float angle = (float) (index * Math.PI * 2d / Math.max(1, found.size()));
                float distance = radius * (0.42f + 0.16f * (index % 3));
                paint.setStyle(Paint.Style.FILL);
                paint.setColor(found.get(index).compatible ? success() : warning());
                canvas.drawCircle(centerX + (float) Math.cos(angle) * distance,
                        centerY + (float) Math.sin(angle) * distance, dp(5), paint);
            }

            paint.setStyle(Paint.Style.FILL);
            paint.setTextAlign(Paint.Align.CENTER);
            paint.setTextSize(dp(11));
            paint.setColor(secondary());
            String label = found.isEmpty()
                    ? (scanning ? "Scanning…" : "Not scanning")
                    : found.size() + (found.size() == 1 ? " phone nearby" : " phones nearby");
            canvas.drawText(label, centerX, getHeight() - dp(6), paint);

            if (attached && scanning) postInvalidateDelayed(60L);
        }
    }

    // ---- downloads ---------------------------------------------------------

    private void renderDownloads() {
        ArrayList<File> files = new ArrayList<>();
        collectTransferFiles(transferDir(), files);
        Collections.sort(files, new Comparator<File>() {
            @Override public int compare(File left, File right) {
                return Long.compare(right.lastModified(), left.lastModified());
            }
        });

        LinearLayout head = card();
        head.setPadding(dp(16), dp(13), dp(16), dp(13));
        head.addView(eyebrow("Saved on this phone"));
        TextView title = heading("Received files", 19f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        titleParams.setMargins(0, dp(6), 0, dp(4));
        head.addView(title, titleParams);
        head.addView(body("Downloads/AEM Transfer · no server copy exists."));
        TextView refresh = link("Refresh list");
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { render(); }
        });
        head.addView(refresh, new LinearLayout.LayoutParams(WRAP, WRAP));
        addCard(head);

        // Active receives: show in-progress/resumable transfers with progress bar
        if (!activeReceives.isEmpty() || receiving) {
            for (int i = 0; i < activeReceives.size(); i++) {
                ActiveReceive a = activeReceives.get(i);
                addCard(activeReceiveCard(a));
            }
            if (activeReceives.isEmpty() && receiving && incomingBusy.get() == false) {
                // Show waiting state when in receive mode but no active transfer yet
                LinearLayout waiting = card();
                waiting.setBackground(rounded(withAlpha(success(), 12), 16, withAlpha(success(), 60)));
                waiting.addView(eyebrow("Receiving active"));
                waiting.addView(body("This phone is visible. Keep this screen open — incoming files will show progress here and in the banner."));
                TextView prog = new TextView(this);
                prog.setText("●  Listening as " + deviceName());
                prog.setTextColor(success());
                prog.setPadding(0, dp(6), 0, 0);
                waiting.addView(prog);
                addCard(waiting);
            }
            // Also show resume-partials that exist on disk even if no active socket
            ArrayList<File> resumeParts = new ArrayList<>();
            File resumeDirFile = resumeDir();
            if (resumeDirFile.isDirectory()) {
                File[] r = resumeDirFile.listFiles();
                if (r != null) {
                    for (File f : r) if (f.getName().endsWith(".part")) resumeParts.add(f);
                }
            }
            if (!resumeParts.isEmpty() && activeReceives.isEmpty()) {
                LinearLayout resumeCard = card();
                resumeCard.setBackground(rounded(withAlpha(warning(), 14), 16, withAlpha(warning(), 60)));
                resumeCard.addView(eyebrow("Resume available"));
                long totalResume = 0L;
                for (File f : resumeParts) totalResume += f.length();
                resumeCard.addView(body(resumeParts.size() + " partial file" + (resumeParts.size()==1?"":"s") + " · " + format(totalResume) + " kept for resume. The next transfer from the same phone will continue where it left off."));
                addCard(resumeCard);
            }
        }

        if (files.isEmpty()) {
            if (!activeReceives.isEmpty()) {
                // Don't show empty state when active receives exist
            } else {
                addEmptyState("↓", "Nothing received yet", "Files sent to this phone from AEM Transfer will appear here, ready to open, install or share.");
                return;
            }
        } else {
            addSectionLabel(files.size() == 1 ? "1 file" : files.size() + " files");
            int limit = Math.min(files.size(), 200);
            for (int index = 0; index < limit; index++) {
                addCard(downloadCard(files.get(index)));
            }
            if (files.size() > limit) content.addView(body("Showing the 200 most recent files."));
        }
    }

    private View downloadCard(final File file) {
        LinearLayout card = card();
        card.setPadding(dp(13), dp(12), dp(13), dp(12));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView badgeTile = tile(fileTile(file), withAlpha(accentSoft(), lightTheme ? 22 : 30), accentSoft());
        badgeTile.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        LinearLayout.LayoutParams tileParams = new LinearLayout.LayoutParams(dp(42), dp(42));
        tileParams.setMargins(0, 0, dp(11), 0);
        row.addView(badgeTile, tileParams);

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView name = text(file.getName(), 13.5f, ink());
        name.setTypeface(bold());
        name.setMaxLines(2);
        name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        texts.addView(name);
        String when = new SimpleDateFormat("d MMM · HH:mm", Locale.getDefault()).format(new Date(file.lastModified()));
        TextView meta = text(format(file.length()) + " · " + when, 10.5f, muted());
        meta.setPadding(0, dp(2), 0, 0);
        texts.addView(meta);
        row.addView(texts, new LinearLayout.LayoutParams(0, WRAP, 1f));
        card.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(0, dp(10), 0, 0);

        boolean packageFile = isPackageFile(file);
        String primaryLabel = packageFile
                ? (isPackageInstalled(file) ? "Open app" : "Install")
                : "Open";
        TextView primary = pill(primaryLabel, true, 38);
        primary.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                if (isPackageFile(file) && isPackageInstalled(file)) openInstalledPackage(file);
                else if (isPackageFile(file)) installPackage(file);
                else openTransferredFile(file);
            }
        });
        actions.addView(primary, new LinearLayout.LayoutParams(0, dp(38), 1f));

        TextView share = pill("Share", false, 38);
        share.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { shareTransferredFile(file); }
        });
        LinearLayout.LayoutParams shareParams = new LinearLayout.LayoutParams(0, dp(38), 1f);
        shareParams.setMargins(dp(6), 0, 0, 0);
        actions.addView(share, shareParams);

        TextView delete = pill("Delete", false, 38);
        delete.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { confirmDelete(file); }
        });
        LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(0, dp(38), 1f);
        deleteParams.setMargins(dp(6), 0, 0, 0);
        actions.addView(delete, deleteParams);

        card.addView(actions, new LinearLayout.LayoutParams(MATCH, WRAP));
        return card;
    }

    private View activeReceiveCard(final ActiveReceive a) {
        LinearLayout card = card();
        card.setBackground(rounded(withAlpha(accent(), 18), 16, withAlpha(accent(), 90)));
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView dot = text("●", 10f, accent());
        head.addView(dot);
        TextView st = text("Receiving from " + (a.sender == null ? "nearby phone" : a.sender), 12f, accentSoft());
        st.setTypeface(bold());
        st.setPadding(dp(6), 0, 0, 0);
        head.addView(st, new LinearLayout.LayoutParams(0, WRAP, 1f));
        TextView pct = text(a.total > 0 ? (a.done * 100 / a.total) + "%" : "…", 12f, ink());
        pct.setTypeface(bold());
        head.addView(pct);
        card.addView(head);
        ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(a.total > 0 ? (int)(a.done * 100 / a.total) : 0);
        bar.setProgressTintList(ColorStateList.valueOf(accent()));
        LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(MATCH, dp(6));
        barParams.setMargins(0, dp(10), 0, dp(4));
        card.addView(bar, barParams);
        TextView detail = text(a.count + (a.count==1?" file":" files") + " · " + format(a.done) + " / " + format(a.total), 11.5f, secondary());
        card.addView(detail);
        return card;
    }

    private String fileTile(File file) {
        String extension = extensionOf(file.getName());
        if (extension.isEmpty()) return "FILE";
        if (extension.length() > 4) extension = extension.substring(0, 4);
        return extension.toUpperCase(Locale.US);
    }

    // ---- history -----------------------------------------------------------

    private void renderHistory() {
        ArrayList<HistoryEntry> entries = readHistory();

        LinearLayout head = card();
        head.setPadding(dp(16), dp(13), dp(16), dp(13));
        head.addView(eyebrow("Recent activity"));
        TextView title = heading("Transfer history", 19f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(MATCH, WRAP);
        titleParams.setMargins(0, dp(6), 0, dp(4));
        head.addView(title, titleParams);
        head.addView(body("Sent, received, installed and failed items are kept on this phone only."));
        if (!entries.isEmpty()) {
            TextView clear = link("Clear history");
            clear.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { confirmClearHistory(); }
            });
            head.addView(clear, new LinearLayout.LayoutParams(WRAP, WRAP));
        }
        addCard(head);

        if (entries.isEmpty()) {
            addEmptyState("↕", "No activity yet", "Send or receive something and the verified result will be listed here.");
            return;
        }

        for (int index = 0; index < entries.size(); index++) {
            addCard(historyCard(entries.get(index)));
        }
    }

    private View historyCard(HistoryEntry entry) {
        LinearLayout card = card();
        card.setPadding(dp(13), dp(11), dp(14), dp(11));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);

        int tone = actionTone(entry.action);
        TextView badge = text(entry.action, 9.5f, toneColor(tone));
        badge.setTypeface(bold());
        badge.setLetterSpacing(0.1f);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(8), dp(5), dp(8), dp(5));
        badge.setBackground(rounded(withAlpha(toneColor(tone), lightTheme ? 18 : 26), 8));
        LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(WRAP, WRAP);
        badgeParams.setMargins(0, 0, dp(11), 0);
        row.addView(badge, badgeParams);

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView name = text(entry.name, 13f, ink());
        name.setTypeface(bold());
        name.setMaxLines(1);
        name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        texts.addView(name);
        String when = entry.time > 0
                ? new SimpleDateFormat("d MMM · HH:mm", Locale.getDefault()).format(new Date(entry.time))
                : "Unknown time";
        String meta = when + (entry.size > 0 ? " · " + format(entry.size) : "")
                + (entry.detail == null || entry.detail.isEmpty() ? "" : " · " + entry.detail);
        TextView metaView = text(meta, 10.5f, muted());
        metaView.setPadding(0, dp(2), 0, 0);
        texts.addView(metaView);
        row.addView(texts, new LinearLayout.LayoutParams(0, WRAP, 1f));

        card.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));
        return card;
    }

    private int actionTone(String action) {
        if ("FAILED".equals(action)) return TONE_DANGER;
        if ("RECEIVED".equals(action) || "INSTALLED".equals(action)) return TONE_SUCCESS;
        if ("SENT".equals(action)) return TONE_ACCENT;
        return TONE_WARNING;
    }

    // ------------------------------------------------------------------ Wi-Fi Direct

    private void initP2p() {
        p2p = (WifiP2pManager) getSystemService(WIFI_P2P_SERVICE);
        if (p2p == null) return;
        p2pChannel = p2p.initialize(this, getMainLooper(), null);
        peerListListener = new WifiP2pManager.PeerListListener() {
            @Override public void onPeersAvailable(android.net.wifi.p2p.WifiP2pDeviceList list) {
                if (list == null || nearby == false) return;
                boolean added = false;
                for (WifiP2pDevice device : list.getDeviceList()) {
                    if (device == null || device.deviceAddress == null) continue;
                    if (peers.containsKey(device.deviceAddress)) continue;
                    String name = device.deviceName;
                    if (name == null || name.trim().isEmpty()) name = "Wi-Fi Direct device";
                    String fallbackToken = "";
                    peers.put(device.deviceAddress, new Peer(device.deviceAddress, name.trim(), fallbackToken, true));
                    added = true;
                }
                if (added) schedulePeerRender();
            }
        };
        p2pReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                String action = intent == null ? null : intent.getAction();
                if (WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION.equals(action)) {
                    int state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1);
                    if (state == WifiP2pManager.WIFI_P2P_STATE_DISABLED) {
                        boolean wasActive = receiving || receivePreparing || scanning;
                        receiving = false;
                        receivePreparing = false;
                        receiveArmed = false;
                        scanning = false;
                        connected = false;
                        connectPending = false;
                        sessionActive.set(false);
                        closeServer();
                        cancelDiscoveryLoop();
                        AemTransferService.stop(AemTransferActivity.this);
                        if (wasActive) {
                            showBanner("Wi-Fi Direct turned off", "Turn Wi-Fi back on, then start again.", TONE_WARNING, 0);
                            render();
                        }
                    }
                } else if (WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(action)) {
                    requestConnectionInfo();
                } else if (WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(action)) {
                    if (p2p != null && p2pChannel != null && hasNearbyPermission()) {
                        try { p2p.requestPeers(p2pChannel, peerListListener); } catch (Exception ignored) {}
                    }
                } else if (WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION.equals(action)) {
                    int discoveryState = intent.getIntExtra(WifiP2pManager.EXTRA_DISCOVERY_STATE, -1);
                    if (discoveryState == WifiP2pManager.WIFI_P2P_DISCOVERY_STOPPED && scanning && nearby) {
                        ui.postDelayed(new Runnable() {
                            @Override public void run() {
                                if (scanning && nearby && hasNearbyPermission()) {
                                    try { p2p.discoverPeers(p2pChannel, noop()); } catch (Exception ignored) {}
                                    try { p2p.discoverServices(p2pChannel, noop()); } catch (Exception ignored) {}
                                }
                            }
                        }, 600L);
                    }
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(p2pReceiver, filter, Context.RECEIVER_EXPORTED);
        else registerReceiver(p2pReceiver, filter);
    }

    private boolean wifiEnabled() {
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            return wifi != null && wifi.isWifiEnabled();
        } catch (Exception error) {
            return true;
        }
    }

    private boolean locationEnabled() {
        if (Build.VERSION.SDK_INT >= 33) return true;
        try {
            android.location.LocationManager manager =
                    (android.location.LocationManager) getSystemService(LOCATION_SERVICE);
            if (manager != null) {
                try {
                    return manager.isLocationEnabled();
                } catch (Exception ignored) {
                    // Fallback for older APIs: check providers enabled
                    return manager.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER)
                            || manager.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER);
                }
            }
            return true;
        } catch (Exception error) {
            return true;
        }
    }

    private boolean wifiReady() {
        return wifiEnabled() && (Build.VERSION.SDK_INT >= 33 || locationEnabled());
    }

    private boolean hasNearbyPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNearbyPermission(String action) {
        pendingPermissionAction = action;
        ArrayList<String> permissions = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33) {
            permissions.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        } else {
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
            permissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        showBanner("Nearby permission needed", "AEM uses Wi-Fi Direct to find the other phone. No internet or location history is used.", TONE_WARNING, 0);
        requestPermissions(permissions.toArray(new String[0]), PERM_NEARBY);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == PERM_NEARBY) {
            if (hasNearbyPermission()) {
                String action = pendingPermissionAction;
                pendingPermissionAction = null;
                hideBanner();
                if ("receive".equals(action)) startReceivingFlow();
                else startSendFlow();
            } else {
                showBanner("Permission not granted", "Allow nearby devices to use AEM Transfer.", TONE_DANGER, 0,
                        "Settings", new Runnable() {
                            @Override public void run() { openAppSettings(); }
                        });
            }
        } else if (requestCode == PERM_MEDIA) {
            if (pendingMediaCategory != null && hasMediaPermission(pendingMediaCategory)) {
                pendingMediaCategory = null;
                render();
            } else if (pendingMediaCategory != null) {
                showBanner("Media access not granted", "You can still send items through Files.", TONE_WARNING, 6000);
            }
        }
    }

    private void openAppSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception error) {
            toast("Open Settings → Apps → AEM → Permissions");
        }
    }

    private void openWifiSettings() {
        try {
            Intent intent = Build.VERSION.SDK_INT >= 29
                    ? new Intent(Settings.Panel.ACTION_WIFI)
                    : new Intent(Settings.ACTION_WIFI_SETTINGS);
            startActivity(intent);
        } catch (Exception error) {
            try { startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)); }
            catch (Exception ignored) { toast("Open Settings → Network & internet → Wi-Fi"); }
        }
    }

    private void openLocationSettings() {
        try { startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); }
        catch (Exception error) { toast("Open Settings → Location"); }
    }

    private boolean hasMediaPermission(String mediaCategory) {
        if (Build.VERSION.SDK_INT < 33) {
            return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(mediaPermission(mediaCategory)) == PackageManager.PERMISSION_GRANTED;
    }

    private String mediaPermission(String mediaCategory) {
        if ("Photos".equals(mediaCategory)) return Manifest.permission.READ_MEDIA_IMAGES;
        if ("Videos".equals(mediaCategory)) return Manifest.permission.READ_MEDIA_VIDEO;
        return Manifest.permission.READ_MEDIA_AUDIO;
    }

    private String permissionToRequest(String mediaCategory) {
        if (Build.VERSION.SDK_INT >= 33) return mediaPermission(mediaCategory);
        return Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    private void requestConnectionInfo() {
        if (p2p == null || p2pChannel == null || !hasNearbyPermission()) return;
        try {
            p2p.requestConnectionInfo(p2pChannel, new WifiP2pManager.ConnectionInfoListener() {
                @Override public void onConnectionInfoAvailable(WifiP2pInfo info) {
                    if (info == null) return;
                    if (!info.groupFormed) {
                        if (connected) {
                            connected = false;
                            activeHost = null;
                            if (!receiving) sessionActive.set(false);
                            if ("Transfer".equals(section) && !nearby) updateBottomBar();
                        }
                        return;
                    }
                    if (!senderRole) {
                        if (!receiving && receiveArmed) {
                            receiving = true;
                            receivePreparing = false;
                            render();
                        }
                        refreshReceiverGroupState();
                        return;
                    }
                    if (sendingNow.get() && connected) return;
                    if (!sessionActive.get() || !connectPending) return;
                    if (info.isGroupOwner) {
                        failLink("This phone became the group owner. Move closer and scan again.");
                        return;
                    }
                    String host = info.groupOwnerAddress == null ? null : info.groupOwnerAddress.getHostAddress();
                    if (host == null || host.isEmpty()) return;
                    connectPending = false;
                    activeHost = host;
                    connected = true;
                    sessionActive.set(true);
                    nearby = false;
                    scanning = false;
                    stopDiscovery();
                    ui.removeCallbacks(connectWatchdog);
                    render();
                    startSendingSelection();
                }
            });
        } catch (Exception ignored) { }
    }

    private final Runnable connectWatchdog = new Runnable() {
        @Override public void run() {
            if (!sessionActive.get() || connected || sendingNow.get()) return;
            failLink("The other phone did not answer. Keep both phones close, then scan again.");
        }
    };

    private void refreshReceiverGroupState() {
        if (p2p == null || p2pChannel == null || senderRole) return;
        try {
            p2p.requestGroupInfo(p2pChannel, new WifiP2pManager.GroupInfoListener() {
                @Override public void onGroupInfoAvailable(WifiP2pGroup group) {
                    if (group == null) return;
                    if (!group.isGroupOwner()) return;
                    boolean hasClients = group.getClientList() != null && !group.getClientList().isEmpty();
                    if (!hasClients && connected) {
                        connected = false;
                        remoteName = null;
                        remoteToken = null;
                        if (receiving) AemTransferService.update("Ready to receive", "Waiting for a nearby phone");
                        if ("Transfer".equals(section)) render();
                    }
                }
            });
        } catch (Exception ignored) { }
    }

    private void failLink(String message) {
        sessionActive.set(false);
        sendingNow.set(false);
        connectPending = false;
        connected = false;
        activeHost = null;
        ui.removeCallbacks(connectWatchdog);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        try { if (p2p != null && p2pChannel != null) p2p.removeGroup(p2pChannel, noop()); } catch (Exception ignored) { }
        if (receiving) AemTransferService.update("Ready to receive", "Waiting for a nearby phone");
        else AemTransferService.stop(this);
        showBanner("Connection failed", message, TONE_DANGER, 0, "Scan again", new Runnable() {
            @Override public void run() { startSendFlow(); }
        });
        if (nearby) render();
        updateBottomBar();
    }

    // ---- discovery ---------------------------------------------------------

    private void startSendFlow() {
        if (!hasNearbyPermission()) {
            pendingPermissionAction = "send";
            requestNearbyPermission("send");
            return;
        }
        pendingPermissionAction = null;
        if (receiving || receivePreparing) stopReceivingFlow(false);
        if (connected && activeHost != null) {
            if (selected.isEmpty()) {
                toast("Pick something to send first, then Send again");
                nearby = true;
                scanning = false;
                render();
                showBanner("Pick files first", "Choose apps, photos or files on the Transfer tab, then return here to send.", TONE_WARNING, 0, "Go to Transfer", new Runnable() {
                    @Override public void run() { nearby = false; scanning = false; stopDiscovery(); render(); }
                });
                return;
            }
            startSendingSelection();
            return;
        }
        senderRole = true;
        receiveMode = false;
        if (senderToken == null) senderToken = randomToken();
        if (!wifiReady()) {
            nearby = true;
            scanning = false;
            render();
            return;
        }
        // Allow scanning even without selection so user can verify the other phone is visible.
        // The actual Send is still gated in connectToPeer/startSendingSelection.
        beginDiscovery();
        if (selected.isEmpty()) {
            showBanner("Pick files to send", "You can scan for phones now. Pick files on the Transfer tab before tapping Send on a device.", TONE_ACCENT, 6000);
        }
    }

    private void beginDiscovery() {
        if (p2p == null || p2pChannel == null) {
            showBanner("Wi-Fi Direct unavailable", "This phone does not expose Wi-Fi Direct to apps.", TONE_DANGER, 7000);
            return;
        }
        nearby = true;
        scanning = true;
        senderRole = true;
        peers.clear();
        render();
        showTransferBanner("Finding a phone", "Keep the other phone on AEM → Receive", 0, false);
        try {
            p2p.stopPeerDiscovery(p2pChannel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { resetGroupThenDiscover(); }
                @Override public void onFailure(int reason) { resetGroupThenDiscover(); }
            });
        } catch (Exception error) {
            resetGroupThenDiscover();
        }
    }

    private void resetGroupThenDiscover() {
        try {
            p2p.removeGroup(p2pChannel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { startServiceDiscovery(); }
                @Override public void onFailure(int reason) { startServiceDiscovery(); }
            });
        } catch (Exception error) {
            startServiceDiscovery();
        }
    }

    private void startServiceDiscovery() {
        if (p2p == null || p2pChannel == null) return;
        try {
            p2p.setDnsSdResponseListeners(p2pChannel, dnsServiceListener, dnsTxtListener);
            p2p.clearServiceRequests(p2pChannel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { addServiceRequest(); }
                @Override public void onFailure(int reason) { addServiceRequest(); }
            });
            p2p.discoverPeers(p2pChannel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() {
                    scanning = true;
                    showTransferBanner("Looking for nearby phones", "Both phones must stay on the Transfer screen", 0, false);
                    scheduleDiscoveryLoop();
                    // Also request legacy peers immediately
                    try { p2p.requestPeers(p2pChannel, peerListListener); } catch (Exception ignored) {}
                }
                @Override public void onFailure(int reason) {
                    // BUSY often means a group already exists; still try service discovery
                    if (reason == WifiP2pManager.BUSY) {
                        scanning = true;
                        showTransferBanner("Looking for nearby phones", "Wi-Fi Direct busy — still scanning for AEM receivers", 0, false);
                        scheduleDiscoveryLoop();
                        addServiceRequest();
                        return;
                    }
                    scanning = false;
                    showBanner("Could not start scanning",
                            reason == WifiP2pManager.BUSY
                                    ? "Wi-Fi Direct is busy. Turn Wi-Fi off and on, then try again."
                                    : "Android refused to start discovery (" + reason + "). On Tecno/Infinix, toggle Wi-Fi and Location, then try again.",
                            TONE_DANGER, 0, "Try again", new Runnable() {
                                @Override public void run() { beginDiscovery(); }
                            });
                    render();
                }
            });
        } catch (Exception error) {
            showBanner("Discovery failed", "Wi-Fi Direct is unavailable right now.", TONE_DANGER, 7000);
        }
    }

    private void addServiceRequest() {
        if (p2p == null || p2pChannel == null) return;
        try {
            serviceRequest = WifiP2pDnsSdServiceRequest.newInstance();
            p2p.addServiceRequest(p2pChannel, serviceRequest, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() {
                    try { p2p.discoverServices(p2pChannel, noop()); } catch (Exception ignored) { }
                }
                @Override public void onFailure(int reason) {
                    showBanner("Service discovery failed", "Android could not listen for AEM receivers (" + reason + ").",
                            TONE_DANGER, 0, "Try again", new Runnable() {
                                @Override public void run() { beginDiscovery(); }
                            });
                }
            });
        } catch (Exception ignored) { }
    }

    private final WifiP2pManager.DnsSdServiceResponseListener dnsServiceListener =
            new WifiP2pManager.DnsSdServiceResponseListener() {
                @Override public void onDnsSdServiceAvailable(String instanceName, String registrationType, WifiP2pDevice device) {
                    // The TXT record carries the identity; nothing to do here.
                }
            };

    private final WifiP2pManager.DnsSdTxtRecordListener dnsTxtListener =
            new WifiP2pManager.DnsSdTxtRecordListener() {
                @Override public void onDnsSdTxtRecordAvailable(String fullDomainName, Map<String, String> record, WifiP2pDevice device) {
                    if (device == null || device.deviceAddress == null || record == null) return;
                    if (!"receiver".equals(record.get("role"))) return;
                    String token = record.get("token");
                    if (token == null || token.trim().isEmpty()) return;
                    String name = record.get("name");
                    if (name == null || name.trim().isEmpty()) name = device.deviceName;
                    if (name == null || name.trim().isEmpty()) name = "Nearby phone";
                    String protocol = record.get("protocol");
                    boolean compatible = protocol == null || String.valueOf(PROTOCOL).equals(protocol);
                    peers.put(device.deviceAddress, new Peer(device.deviceAddress, name.trim(), token, compatible));
                    schedulePeerRender();
                }
            };

    private void schedulePeerRender() {
        if (!nearby) return;
        if (peerRefreshRunnable != null) ui.removeCallbacks(peerRefreshRunnable);
        peerRefreshRunnable = new Runnable() {
            @Override public void run() {
                peerRefreshRunnable = null;
                if (nearby && "Transfer".equals(section)) render();
            }
        };
        ui.postDelayed(peerRefreshRunnable, 220L);
    }

    private void scheduleDiscoveryLoop() {
        cancelDiscoveryLoop();
        discoveryLoop = new Runnable() {
            @Override public void run() {
                if (!nearby || !scanning) return;
                if (p2p != null && p2pChannel != null && hasNearbyPermission()) {
                    try { p2p.discoverServices(p2pChannel, noop()); } catch (Exception ignored) {}
                    if (Math.random() < 0.5) {
                        try { p2p.discoverPeers(p2pChannel, noop()); } catch (Exception ignored) {}
                    }
                    try { p2p.requestPeers(p2pChannel, peerListListener); } catch (Exception ignored) {}
                }
                ui.postDelayed(this, DISCOVERY_INTERVAL_MS);
            }
        };
        ui.postDelayed(discoveryLoop, DISCOVERY_INTERVAL_MS);
    }

    private void cancelDiscoveryLoop() {
        if (discoveryLoop != null) {
            ui.removeCallbacks(discoveryLoop);
            discoveryLoop = null;
        }
    }

    private void connectToPeer(final Peer peer) {
        if (peer == null) return;
        if (!peer.compatible) {
            showBanner("Update AEM on the other phone", "Both phones need the same transfer protocol. Update the app, then scan again.", TONE_WARNING, 8000);
            return;
        }
        if (selected.isEmpty()) {
            showBanner("Pick files first", "Choose at least one app, photo or file on the Transfer tab, then tap Send on " + peer.name + ".", TONE_WARNING, 6000, "Go to Transfer", new Runnable() {
                @Override public void run() {
                    nearby = false;
                    scanning = false;
                    stopDiscovery();
                    render();
                }
            });
            toast("Pick something to send first");
            return;
        }
        // Legacy fallback peer may have empty token: allow attempt, handshake will validate.
        // Show hint if token empty.
        if (p2p == null || p2pChannel == null) {
            toast("Wi-Fi Direct is unavailable");
            return;
        }
        if (sendingNow.get() || (sessionActive.get() && connected)) {
            toast("A transfer is already running");
            return;
        }
        remoteToken = peer.token;
        remoteName = peer.name;
        senderRole = true;
        connectPending = true;
        sessionActive.set(true);
        showTransferBanner("Connecting to " + peer.name, "Approve the connection on both phones if Android asks", 0, false);
        try {
            WifiP2pConfig config = new WifiP2pConfig();
            config.deviceAddress = peer.address;
            config.wps.setup = WpsInfo.PBC;
            config.groupOwnerIntent = 0; // keep the receiver as group owner so the sender can dial it
            p2p.connect(p2pChannel, config, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() {
                    ui.removeCallbacks(connectWatchdog);
                    ui.postDelayed(connectWatchdog, 30_000L);
                }
                @Override public void onFailure(int reason) {
                    failLink("Android refused the connection (" + reason + "). Move the phones closer and try again.");
                }
            });
        } catch (Exception error) {
            failLink("Could not start the connection.");
        }
    }

    private void disconnectLink() {
        if (sendingNow.get()) {
            sendAborted = true;
        }
        sessionActive.set(false);
        sendingNow.set(false);
        activeTransferCancel = null;
        connectPending = false;
        connected = false;
        activeHost = null;
        remoteToken = null;
        senderToken = null;
        remoteName = null;
        ui.removeCallbacks(connectWatchdog);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        try { if (p2p != null && p2pChannel != null) p2p.removeGroup(p2pChannel, noop()); } catch (Exception ignored) { }
        if (receiving) AemTransferService.update("Ready to receive", "Waiting for a nearby phone");
        else AemTransferService.stop(this);
        showBanner("Disconnected", "The local link is closed. Nothing is left running.", TONE_ACCENT, 4000);
        render();
    }

    private void swapLinkDirection() {
        // Let user reverse sender/receiver without manual disconnect + mode switch.
        if (sendingNow.get()) {
            toast("Wait for the current transfer to finish");
            return;
        }
        if (senderRole && connected) {
            // Was sender, become receiver
            sessionActive.set(false);
            sendingNow.set(false);
            connected = false;
            activeHost = null;
            remoteName = null;
            remoteToken = null;
            ui.removeCallbacks(connectWatchdog);
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            try { if (p2p != null && p2pChannel != null) p2p.removeGroup(p2pChannel, noop()); } catch (Exception ignored) { }
            AemTransferService.stop(this);
            receiveMode = true;
            senderRole = false;
            showBanner("Switched to Receive", "Now the other phone can send to you. Tap Start receiving.", TONE_ACCENT, 5000);
            render();
            // Auto-start receiving for convenience
            startReceivingFlow();
        } else if (receiving || receiveArmed) {
            // Was receiver, become sender
            stopReceivingFlow(false);
            receiveMode = false;
            senderRole = true;
            if (senderToken == null) senderToken = randomToken();
            showBanner("Switched to Send", "Pick files, then scan for the other phone.", TONE_ACCENT, 5000);
            render();
            if (!selected.isEmpty()) beginDiscovery();
        } else {
            toast("Start Send or Receive first");
        }
    }

    private void stopDiscovery() {
        scanning = false;
        cancelDiscoveryLoop();
        if (peerRefreshRunnable != null) {
            ui.removeCallbacks(peerRefreshRunnable);
            peerRefreshRunnable = null;
        }
        peers.clear();
        try { if (p2p != null && p2pChannel != null) p2p.stopPeerDiscovery(p2pChannel, noop()); } catch (Exception ignored) { }
        try { if (p2p != null && p2pChannel != null) p2p.clearServiceRequests(p2pChannel, noop()); } catch (Exception ignored) { }
        serviceRequest = null;
    }

    // ---- receiving ---------------------------------------------------------

    private void startReceivingFlow() {
        if (!hasNearbyPermission()) {
            pendingPermissionAction = "receive";
            requestNearbyPermission("receive");
            return;
        }
        receiveMode = true;
        senderRole = false;
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERM_NOTIFICATIONS); }
            catch (Exception ignored) { }
        }
        if (!wifiReady()) {
            nearby = false;
            scanning = false;
            render();
            return;
        }
        if (p2p == null || p2pChannel == null) {
            showBanner("Wi-Fi Direct unavailable", "This phone does not expose Wi-Fi Direct to apps.", TONE_DANGER, 7000);
            return;
        }
        stopDiscovery();
        nearby = false;
        receiving = false;
        receivePreparing = true;
        localToken = randomToken();
        if (senderToken == null) senderToken = randomToken();
        startServer();
        receiveArmed = true;
        advertiseReceiver();
        createReceiverGroup(0);
        render();
    }

    private void createReceiverGroup(final int attempt) {
        if (p2p == null || p2pChannel == null) return;
        try {
            p2p.removeGroup(p2pChannel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { doCreateReceiverGroup(attempt); }
                @Override public void onFailure(int reason) { doCreateReceiverGroup(attempt); }
            });
        } catch (Exception error) {
            doCreateReceiverGroup(attempt);
        }
    }

    private void doCreateReceiverGroup(final int attempt) {
        if (p2p == null || p2pChannel == null) return;
        try {
            p2p.createGroup(p2pChannel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() {
                    receivePreparing = false;
                    receiving = true;
                    connected = false;
                    AemTransferService.start(AemTransferActivity.this, "Ready to receive", "Waiting for a nearby phone");
                    showBanner("Ready to receive", "This phone is visible as " + deviceName(), TONE_SUCCESS, 5000);
                    // Re-advertise after group creation to ensure TXT propagates (XOS needs this)
                    try {
                        if (localService == null) advertiseReceiver();
                        else {
                            // Keep existing advertisement, but ensure it's still valid after group
                            try { p2p.removeLocalService(p2pChannel, localService, noop()); } catch (Exception ignored) {}
                            localService = null;
                            advertiseReceiver();
                        }
                    } catch (Exception ignored) {}
                    render();
                }
                @Override public void onFailure(int reason) {
                    if (attempt < 2) {
                        ui.postDelayed(new Runnable() {
                            @Override public void run() { createReceiverGroup(attempt + 1); }
                        }, 1200L);
                    } else {
                        receivePreparing = false;
                        receiving = false;
                        showBanner("Could not start receiving",
                                reason == WifiP2pManager.BUSY
                                        ? "Wi-Fi Direct is busy. Turn Wi-Fi off and on, then try again."
                                        : "Android refused to create the local group (" + reason + ").",
                                TONE_DANGER, 0, "Try again", new Runnable() {
                                    @Override public void run() { startReceivingFlow(); }
                                });
                        render();
                    }
                }
            });
        } catch (Exception error) {
            receivePreparing = false;
            receiving = false;
            showBanner("Could not start receiving", "Wi-Fi Direct is unavailable right now.", TONE_DANGER, 7000);
            render();
        }
    }

    private void advertiseReceiver() {
        if (p2p == null || p2pChannel == null || localToken == null) return;
        HashMap<String, String> record = new HashMap<>();
        record.put("role", "receiver");
        record.put("name", deviceName());
        record.put("token", localToken);
        record.put("port", String.valueOf(PORT));
        record.put("protocol", String.valueOf(PROTOCOL));
        String instance = "AEM-" + deviceName().replaceAll("[^A-Za-z0-9_-]", "-");
        if (instance.length() > 48) instance = instance.substring(0, 48);
        instance = instance + "-" + localToken.substring(0, 4);
        try {
            localService = WifiP2pDnsSdServiceInfo.newInstance(instance, "_aemtransfer._tcp", record);
            p2p.addLocalService(p2pChannel, localService, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { }
                @Override public void onFailure(int reason) {
                    localService = null;
                    showBanner("Not visible to nearby phones", "Android could not advertise this device (" + reason + "). Tap Receive to retry.", TONE_WARNING, 8000);
                }
            });
        } catch (Exception error) {
            localService = null;
        }
    }

    private void stopReceivingFlow(boolean rerender) {
        boolean wasActive = receiving || receivePreparing;
        receiving = false;
        receivePreparing = false;
        receiveArmed = false;
        connected = false;
        remoteName = null;
        localToken = null;
        remoteToken = null;
        sessionActive.set(false);
        sendingNow.set(false);
        closeServer();
        synchronized (activeReceives) { activeReceives.clear(); }
        try { if (p2p != null && p2pChannel != null && localService != null) p2p.removeLocalService(p2pChannel, localService, noop()); } catch (Exception ignored) { }
        localService = null;
        try { if (p2p != null && p2pChannel != null) p2p.removeGroup(p2pChannel, noop()); } catch (Exception ignored) { }
        AemTransferService.stop(this);
        if (wasActive) showBanner("Receiving stopped", "This phone is no longer visible to nearby devices.", TONE_ACCENT, 4000);
        if (rerender) render();
    }

    private String randomToken() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    private void showRenameDialog() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(deviceName());
        input.setSelectAllOnFocus(true);
        input.setTextColor(ink());
        input.setHintTextColor(muted());
        input.setBackground(rounded(sunken(), 12, sunkenBorder()));
        input.setPadding(dp(12), dp(8), dp(12), dp(8));

        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setPadding(dp(20), dp(6), dp(20), dp(2));
        shell.addView(input, new LinearLayout.LayoutParams(MATCH, WRAP));

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Transfer device name")
                .setMessage("This is the name the other phone sees. Use something recognisable.")
                .setView(shell)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save", null)
                .create();
        dialog.setOnShowListener(new android.content.DialogInterface.OnShowListener() {
            @Override public void onShow(android.content.DialogInterface ignored) {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View view) {
                        String value = input.getText() == null ? "" : input.getText().toString().trim();
                        if (value.isEmpty()) value = Build.MODEL == null ? "Android phone" : Build.MODEL;
                        if (value.length() > 40) value = value.substring(0, 40).trim();
                        prefs.edit().putString("name", value).apply();
                        if (receiving) {
                            try { if (p2p != null && p2pChannel != null && localService != null) p2p.removeLocalService(p2pChannel, localService, noop()); } catch (Exception ignored) { }
                            localService = null;
                            advertiseReceiver();
                        }
                        dialog.dismiss();
                        render();
                    }
                });
            }
        });
        dialog.show();
        styleDialog(dialog);
        try {
            dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
            input.requestFocus();
        } catch (Exception ignored) { }
    }

    private String deviceName() {
        String saved = prefs == null ? null : prefs.getString("name", "");
        if (saved != null && !saved.trim().isEmpty()) return saved.trim();
        try {
            String system = Settings.Global.getString(getContentResolver(), "device_name");
            if (system != null && !system.trim().isEmpty()) return system.trim();
        } catch (Exception ignored) { }
        return Build.MODEL == null || Build.MODEL.trim().isEmpty() ? "Android phone" : Build.MODEL.trim();
    }

    // ------------------------------------------------------------------ storage

    private File transferDir() {
        File base = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (base == null) base = new File(getFilesDir(), "downloads");
        File dir = new File(base, TRANSFER_FOLDER);
        if (dir.exists() || dir.mkdirs()) return dir;
        File fallback = new File(getFilesDir(), TRANSFER_FOLDER);
        if (!fallback.exists()) fallback.mkdirs();
        return fallback;
    }

    private File resumeDir() {
        File dir = new File(transferDir(), ".resume");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File resumeFile(String id, int index, String suffix) {
        return new File(resumeDir(), id + "-" + index + "." + suffix);
    }

    private void collectTransferFiles(File dir, ArrayList<File> out) {
        if (dir == null || !dir.isDirectory()) return;
        File[] children = dir.listFiles();
        if (children == null) return;
        for (int index = 0; index < children.length; index++) {
            File child = children[index];
            if (child.isDirectory()) {
                if (!".resume".equals(child.getName())) collectTransferFiles(child, out);
            } else if (!child.getName().endsWith(".part") && !child.getName().endsWith(".done")) {
                out.add(child);
            }
        }
    }

    private void pruneResumeFiles() {
        File dir = new File(transferDir(), ".resume");
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - 7L * 24L * 60L * 60L * 1000L;
        for (int index = 0; index < files.length; index++) {
            if (files[index].lastModified() < cutoff) files[index].delete();
        }
    }

    private String format(long bytes) {
        if (bytes < 1024L) return bytes + " B";
        double value = bytes;
        if (value < 1024d * 1024d) return String.format(Locale.US, "%.1f KB", value / 1024d);
        if (value < 1024d * 1024d * 1024d) return String.format(Locale.US, "%.1f MB", value / (1024d * 1024d));
        return String.format(Locale.US, "%.2f GB", value / (1024d * 1024d * 1024d));
    }

    private String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 || dot == name.length() - 1 ? "" : name.substring(dot + 1).toLowerCase(Locale.US);
    }

    // ------------------------------------------------------------------ servers

    private void startServer() {
        synchronized (serverLock) {
            if (server != null && !server.isClosed()) return;
            try {
                ServerSocket socket = new ServerSocket();
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(PORT));
                server = socket;
            } catch (Exception error) {
                showBanner("Could not open the receiver", "Port " + PORT + " is unavailable. Close other transfer apps and try again.", TONE_DANGER, 8000);
                return;
            }
        }
        io.execute(new Runnable() {
            @Override public void run() {
                while (!Thread.currentThread().isInterrupted()) {
                    ServerSocket current;
                    synchronized (serverLock) { current = server; }
                    if (current == null || current.isClosed()) break;
                    try {
                        final Socket socket = current.accept();
                        openSockets.add(socket);
                        io.execute(new Runnable() {
                            @Override public void run() {
                                try { handleIncoming(socket); }
                                finally {
                                    openSockets.remove(socket);
                                    closeQuietly(socket);
                                }
                            }
                        });
                    } catch (Exception error) {
                        break;
                    }
                }
            }
        });
    }

    private void closeServer() {
        synchronized (serverLock) {
            try { if (server != null) server.close(); } catch (Exception ignored) { }
            server = null;
        }
        ArrayList<Socket> sockets;
        synchronized (openSockets) { sockets = new ArrayList<>(openSockets); }
        for (int index = 0; index < sockets.size(); index++) closeQuietly(sockets.get(index));
        openSockets.clear();
    }

    private void closeQuietly(Socket socket) {
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
    }

    private void closeIncomingDialog() {
        if (incomingDialog != null) {
            try { incomingDialog.dismiss(); } catch (Exception ignored) { }
            incomingDialog = null;
        }
    }

    // ------------------------------------------------------------------ sender

    private String activeSignature = null;

    private String signatureOf(List<Item> items) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < items.size(); index++) {
            Item item = items.get(index);
            builder.append(item.path).append('\u0000').append(item.size).append('\n');
        }
        return builder.toString();
    }

    private void startSendingSelection() {
        final String host = activeHost;
        if (host == null) {
            showBanner("Not connected", "Scan for the other phone again.", TONE_WARNING, 6000);
            return;
        }
        if (selected.isEmpty()) {
            toast("Pick something to send first");
            return;
        }
        if (!sendingNow.compareAndSet(false, true)) return;

        final ArrayList<Item> items = new ArrayList<>(selected);
        String signature = signatureOf(items);
        if (transferId == null || activeSignature == null || !activeSignature.equals(signature)) {
            transferId = UUID.randomUUID().toString();
            activeSignature = signature;
        }
        sessionActive.set(true);
        senderRole = true;
        sendAborted = false;
        activeTransferCancel = new Runnable() {
            @Override public void run() {
                if (!sendingNow.get()) return;
                sendAborted = true;
                sessionActive.set(false);
                activeTransferCancel = null;
                showBanner("Transfer cancelled", "The link stays open so you can send again.", TONE_ACCENT, 4000);
                updateBottomBar();
            }
        };
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        showTransferBanner("Sending " + items.size() + (items.size() == 1 ? " item" : " items"), "Waiting for the other phone…", 0, false);
        AemTransferService.start(this, "Sending files", "Connecting to the other phone");

        io.execute(new Runnable() {
            @Override public void run() {
                final String error = runSend(host, items);
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        sendingNow.set(false);
                        activeTransferCancel = null;
                        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        if (sendAborted) {
                            sendAborted = false;
                            updateBottomBar();
                            render();
                            return;
                        }
                        if (error == null) {
                            for (int index = 0; index < items.size(); index++) {
                                Item item = items.get(index);
                                recordHistory("SENT", item.path, item.size, "Verified");
                            }
                            for (int index = 0; index < items.size(); index++) {
                                Item item = items.get(index);
                                selected.remove(item);
                                selectedKeys.remove(item.key);
                            }
                            transferId = null;
                            activeSignature = null;
                            updateBottomBar();
                            if (receiving) AemTransferService.update("Ready to receive", "Waiting for a nearby phone");
                            else AemTransferService.stop(AemTransferActivity.this);
                            showBanner("Transfer complete",
                                    items.size() + (items.size() == 1 ? " item sent and verified." : " items sent and verified."),
                                    TONE_SUCCESS, 7000);
                            render();
                        } else {
                            AemTransferService.stop(AemTransferActivity.this);
                            if (receiving) AemTransferService.update("Ready to receive", "Waiting for a nearby phone");
                            showBanner("Transfer interrupted", error, TONE_DANGER, 0, "Retry", new Runnable() {
                                @Override public void run() { startSendingSelection(); }
                            });
                            render();
                        }
                    }
                });
            }
        });
    }

    private String runSend(String host, ArrayList<Item> items) {
        String lastError = "The transfer stopped.";
        for (int attempt = 1; attempt <= 3; attempt++) {
            if (!sessionActive.get()) return "The transfer was stopped.";
            try {
                sendOnce(host, items);
                return null;
            } catch (FatalTransferException error) {
                return describe(error);
            } catch (Exception error) {
                lastError = describe(error);
                if (!sessionActive.get()) return "The transfer was stopped.";
                if (attempt < 3) {
                    sleep(500L * attempt);
                }
            }
        }
        return lastError;
    }

    private void sendOnce(String host, ArrayList<Item> items) throws Exception {
        Socket socket = new Socket();
        openSockets.add(socket);
        try {
            socket.setTcpNoDelay(true);
            socket.setSendBufferSize(1024 * 1024);
            socket.connect(new InetSocketAddress(host, PORT), 12_000);
            socket.setSoTimeout(120_000);

            DataOutputStream out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), 256 * 1024));
            out.writeInt(PROTOCOL);
            out.writeUTF(transferId == null ? UUID.randomUUID().toString() : transferId);
            out.writeUTF(deviceName());
            out.writeUTF(remoteToken == null ? "" : remoteToken);
            out.writeUTF(senderToken == null ? "" : senderToken);

            long total = 0L;
            for (int index = 0; index < items.size(); index++) total += items.get(index).size;
            out.writeInt(items.size());
            out.writeLong(total);
            for (int index = 0; index < items.size(); index++) {
                Item item = items.get(index);
                byte[] name = item.path.getBytes(StandardCharsets.UTF_8);
                if (name.length == 0 || name.length > 16000) throw new IOException("A file name is too long to send.");
                out.writeInt(name.length);
                out.write(name);
                out.writeLong(item.size);
            }
            out.flush();

            DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 128 * 1024));
            int accepted = in.readInt();
            if (accepted != 1) throw new FatalTransferException("The other phone declined this transfer.");

            long[] offsets = new long[items.size()];
            long done = 0L;
            for (int index = 0; index < items.size(); index++) {
                offsets[index] = in.readLong();
                if (offsets[index] < 0 || offsets[index] > items.get(index).size) {
                    throw new IOException("The other phone reported an invalid resume point.");
                }
                done += offsets[index];
            }

            SpeedMeter meter = new SpeedMeter();
            byte[] buffer = new byte[512 * 1024];
            long paintedAt = 0L;

            for (int index = 0; index < items.size(); index++) {
                Item item = items.get(index);
                long offset = offsets[index];
                if (offset >= item.size) continue;

                InputStream input = openItem(item);
                if (input == null) throw new IOException("Cannot read " + item.label() + ".");
                try {
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    long remaining = offset;
                    while (remaining > 0) {
                        int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                        if (read < 0) throw new EOFException("The source file changed while sending.");
                        digest.update(buffer, 0, read);
                        remaining -= read;
                    }
                    long left = item.size - offset;
                    while (left > 0) {
                        if (!sessionActive.get()) throw new IOException("The transfer was stopped.");
                        int read = input.read(buffer, 0, (int) Math.min(buffer.length, left));
                        if (read < 0) throw new EOFException("The source file changed while sending.");
                        out.write(buffer, 0, read);
                        digest.update(buffer, 0, read);
                        left -= read;
                        done += read;
                        long now = System.currentTimeMillis();
                        if (now - paintedAt > 150L) {
                            paintedAt = now;
                            final String detail = percent(done, total) + "% · " + meter.update(done) + " · " + item.label();
                            final int value = percent(done, total);
                            runOnUiThread(new Runnable() {
                                @Override public void run() {
                                    showTransferBanner("Sending " + (items.size() == 1 ? "1 item" : items.size() + " items"), detail, value, true);
                                }
                            });
                        }
                    }
                    out.write(digest.digest());
                    out.flush();
                } finally {
                    try { input.close(); } catch (Exception ignored) { }
                }
            }

            int result = in.readInt();
            if (result != 1) throw new IOException("The other phone could not verify the files.");
        } finally {
            openSockets.remove(socket);
            closeQuietly(socket);
        }
    }

    private InputStream openItem(Item item) throws IOException {
        if (item.uri != null) return getContentResolver().openInputStream(item.uri);
        if (item.file != null) return new BufferedInputStream(new FileInputStream(item.file), 512 * 1024);
        return null;
    }

    // ------------------------------------------------------------------ receiver

    private void handleIncoming(Socket socket) {
        boolean completed = false;
        ArrayList<Header> headers = new ArrayList<>();
        String id = null;
        String host = null;
        long total = 0L;
        boolean locked = false;
        ActiveReceive active = null;
        try {
            host = socket.getInetAddress() == null ? "nearby phone" : socket.getInetAddress().getHostAddress();
            if (!receiveArmed) throw new IOException("This phone is not receiving.");
            if (!incomingBusy.compareAndSet(false, true)) throw new IOException("Another transfer is already in progress.");
            locked = true;

            socket.setTcpNoDelay(true);
            socket.setReceiveBufferSize(1024 * 1024);
            socket.setSoTimeout(120_000);

            DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 256 * 1024));
            DataOutputStream out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), 128 * 1024));

            int protocol = in.readInt();
            if (protocol != PROTOCOL) {
                try { out.writeInt(0); out.flush(); } catch (Exception ignored) { }
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        showBanner("Different AEM version", "Update AEM on the other phone, then try again.", TONE_WARNING, 0);
                    }
                });
                return;
            }

            id = in.readUTF();
            if (id == null || !id.matches("[A-Za-z0-9-]{8,64}")) throw new IOException("Invalid transfer identifier.");
            String senderName = in.readUTF();
            if (senderName == null || senderName.trim().isEmpty()) senderName = "A nearby phone";
            if (senderName.length() > 64) senderName = senderName.substring(0, 64);
            String token = in.readUTF();
            String peerToken = in.readUTF();
            if (localToken == null || token == null || !MessageDigest.isEqual(
                    localToken.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8))) {
                throw new IOException("The handshake did not match this phone.");
            }
            if (peerToken == null || peerToken.trim().isEmpty()) throw new IOException("The other phone did not identify itself.");
            remoteToken = peerToken;
            remoteName = senderName.trim();
            final String senderLabel = remoteName;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (receiving && receiveMode) render();
                }
            });

            int count = in.readInt();
            if (count < 1 || count > MAX_ITEMS) throw new IOException("Invalid item count.");
            total = in.readLong();
            if (total < 0 || total > MAX_TOTAL_BYTES) throw new IOException("The transfer is too large.");

            long declared = 0L;
            for (int index = 0; index < count; index++) {
                int nameLength = in.readInt();
                if (nameLength < 1 || nameLength > 16000) throw new IOException("Invalid file name.");
                byte[] nameBytes = new byte[nameLength];
                in.readFully(nameBytes);
                String path = safePath(new String(nameBytes, StandardCharsets.UTF_8));
                long size = in.readLong();
                if (size < 0 || size > MAX_ITEM_BYTES) throw new IOException("Invalid file size.");
                declared += size;
                if (declared > MAX_TOTAL_BYTES) throw new IOException("The transfer is too large.");
                headers.add(new Header(path, size));
            }
            if (declared != total) total = declared;
            final String summary = count + (count == 1 ? " item" : " items") + " · " + format(total);

            final String signature = signatureOf(headers);
            String completedId = prefs.getString("completed_id", "");
            String completedSignature = prefs.getString("completed_signature", "");
            boolean replay = id.equals(completedId) && signature.equals(completedSignature);

            final String localId = id;
            boolean accepted = replay || confirmIncoming(senderLabel, count, total, host, localId);
            if (!accepted) {
                try { out.writeInt(0); out.flush(); } catch (Exception ignored) { }
                final String declinedBy = senderLabel;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        showBanner("Transfer declined", declinedBy + " was not accepted.", TONE_WARNING, 5000);
                    }
                });
                recordHistory("DECLINED", senderLabel, total, "Declined on this phone");
                return;
            }

            connected = true;
            out.writeInt(1);
            File destination = transferDir();
            long[] offsets = new long[count];
            for (int index = 0; index < count; index++) {
                if (replay) {
                    offsets[index] = headers.get(index).size;
                    continue;
                }
                File done = resumeFile(id, index, "done");
                if (done.exists()) {
                    offsets[index] = headers.get(index).size;
                    continue;
                }
                File part = resumeFile(id, index, "part");
                long length = part.exists() ? part.length() : 0L;
                if (length > headers.get(index).size) {
                    part.delete();
                    length = 0L;
                }
                offsets[index] = length;
            }
            for (int index = 0; index < count; index++) out.writeLong(offsets[index]);
            out.flush();

            if (replay) {
                out.writeInt(1);
                out.flush();
                completed = true;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        showBanner("Already received", "This transfer was completed earlier — nothing was duplicated.", TONE_SUCCESS, 6000);
                    }
                });
                return;
            }

            long doneBytes = 0L;
            for (int index = 0; index < count; index++) doneBytes += offsets[index];
            final SpeedMeter meter = new SpeedMeter();
            byte[] buffer = new byte[512 * 1024];
            long paintedAt = 0L;
            active = new ActiveReceive();
            active.sender = senderLabel;
            active.total = total;
            active.done = doneBytes;
            active.count = count;
            active.startedAt = System.currentTimeMillis();
            active.completed = false;
            synchronized (activeReceives) { activeReceives.clear(); activeReceives.add(active); }
            // Pre-populate Downloads banner if user already on that tab
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if ("Downloads".equals(section)) render();
                }
            });

            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (!receiving) return;
                    showBanner("Receiving from " + senderLabel, summary + " · keep this screen open", TONE_ACCENT, 0);
                    AemTransferService.start(AemTransferActivity.this, "Receiving files", senderLabel + " · " + summary);
                }
            });

            for (int index = 0; index < count; index++) {
                if (!receiveArmed) throw new IOException("Receiving was stopped.");
                Header header = headers.get(index);
                long offset = offsets[index];
                if (header.size == 0L && !resumeFile(id, index, "done").exists()) {
                    File emptyTarget = unique(new File(destination, header.path));
                    File emptyParent = emptyTarget.getParentFile();
                    if (emptyParent != null && !emptyParent.exists() && !emptyParent.mkdirs()) {
                        throw new IOException("Cannot create the destination folder.");
                    }
                    if (!emptyTarget.createNewFile() && !emptyTarget.exists()) {
                        throw new IOException("Cannot create " + baseName(header.path) + ".");
                    }
                    resumeFile(id, index, "done").createNewFile();
                    recordHistory("RECEIVED", emptyTarget.getName(), 0L, "Verified");
                    continue;
                }
                if (offset >= header.size) continue;
                File part = resumeFile(id, index, "part");
                try (OutputStream fileOut = new BufferedOutputStream(new FileOutputStream(part, true), 256 * 1024)) {
                    long left = header.size - offset;
                    while (left > 0) {
                        int read = in.read(buffer, 0, (int) Math.min(buffer.length, left));
                        if (read < 0) throw new EOFException("The connection ended early.");
                        fileOut.write(buffer, 0, read);
                        left -= read;
                        doneBytes += read;
                        active.done = doneBytes;
                        long now = System.currentTimeMillis();
                        if (now - paintedAt > 150L) {
                            paintedAt = now;
                            final String detail = percent(doneBytes, total) + "% · " + meter.update(doneBytes) + " · " + baseName(header.path);
                            final int value = percent(doneBytes, total);
                            runOnUiThread(new Runnable() {
                                @Override public void run() {
                                    showTransferBanner("Receiving from " + senderLabel, detail, value, true);
                                }
                            });
                        }
                    }
                }

                byte[] expected = new byte[32];
                in.readFully(expected);
                byte[] actual;
                try (InputStream hashInput = new FileInputStream(part)) {
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    int read;
                    while ((read = hashInput.read(buffer)) != -1) if (read > 0) digest.update(buffer, 0, read);
                    actual = digest.digest();
                }
                if (!Arrays.equals(expected, actual)) {
                    part.delete();
                    throw new IOException("The integrity check failed for " + baseName(header.path) + ".");
                }

                File target = unique(new File(destination, header.path));
                File parent = target.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Cannot create the destination folder.");
                if (!part.renameTo(target)) {
                    copyFile(part, target);
                    part.delete();
                }
                File done = resumeFile(id, index, "done");
                if (!done.createNewFile() && !done.exists()) throw new IOException("Cannot store resume state.");
                recordHistory("RECEIVED", target.getName(), target.length(), "Verified");
            }

            out.writeInt(1);
            out.flush();

            prefs.edit()
                    .putString("completed_id", id)
                    .putString("completed_signature", signature)
                    .apply();
            for (int index = 0; index < count; index++) {
                resumeFile(id, index, "part").delete();
                resumeFile(id, index, "done").delete();
            }
            completed = true;
            acceptedTransferId = id;
            acceptedHost = host;
            active.completed = true;
            synchronized (activeReceives) { activeReceives.remove(active); }

            final int doneCount = count;
            final long totalBytes = total;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    connected = true;
                    showBanner("Transfer complete",
                            doneCount + (doneCount == 1 ? " item" : " items") + " · " + format(totalBytes) + " saved to Downloads",
                            TONE_SUCCESS, 8000, "Downloads", new Runnable() {
                                @Override public void run() {
                                    section = "Downloads";
                                    render();
                                }
                            });
                    AemTransferService.update("Ready to receive", "Waiting for a nearby phone");
                    render();
                }
            });
        } catch (Exception error) {
            final String message = describe(error);
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    showBanner("Incoming transfer stopped", message, TONE_DANGER, 8000);
                    if (receiving) AemTransferService.update("Ready to receive", "Waiting for a nearby phone");
                    if ("Transfer".equals(section)) render();
                }
            });
            if (!completed && !headers.isEmpty()) {
                Header first = headers.get(0);
                recordHistory("FAILED", first.path, total,
                        "Interrupted · partial data kept for resume");
            }
        } finally {
            if (locked) incomingBusy.set(false);
            closeIncomingDialog();
            if (!completed) {
                synchronized (activeReceives) { activeReceives.remove(active); }
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if ("Downloads".equals(section)) render();
                    }
                });
            }
            if (!completed && receiving) {
                // The link stays alive; a retry from the sender can resume from the receiver's offsets.
                runOnUiThread(new Runnable() {
                    @Override public void run() { updateBottomBar(); }
                });
            }
        }
    }

    private boolean confirmIncoming(final String from, final int count, final long total,
                                    final String host, final String id) {
        if (id.equals(acceptedTransferId) && acceptedHost != null && acceptedHost.equals(host)) return true;

        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicBoolean accepted = new AtomicBoolean(false);
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (isFinishing() || isDestroyed()) {
                    latch.countDown();
                    return;
                }
                closeIncomingDialog();
                AlertDialog dialog = new AlertDialog.Builder(AemTransferActivity.this)
                        .setTitle("Incoming transfer")
                        .setMessage(from + " wants to send " + count + (count == 1 ? " item" : " items")
                                + " · " + format(total) + ".\n\nAccept only if you know this phone.")
                        .setPositiveButton("Accept", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface ignored, int which) {
                                accepted.set(true);
                                acceptedTransferId = id;
                                acceptedHost = host;
                                latch.countDown();
                            }
                        })
                        .setNegativeButton("Decline", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface ignored, int which) {
                                latch.countDown();
                            }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override public void onCancel(android.content.DialogInterface ignored) {
                                latch.countDown();
                            }
                        })
                        .create();
                dialog.setCanceledOnTouchOutside(false);
                incomingDialog = dialog;
                try {
                    dialog.show();
                    styleDialog(dialog);
                } catch (Exception error) {
                    incomingDialog = null;
                    latch.countDown();
                }
            }
        });

        boolean answered = false;
        try { answered = latch.await(60, TimeUnit.SECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        if (!answered) {
            runOnUiThread(new Runnable() {
                @Override public void run() { closeIncomingDialog(); }
            });
        }
        return accepted.get();
    }

    private String signatureOf(ArrayList<Header> headers) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < headers.size(); index++) {
            builder.append(headers.get(index).path).append('\u0000').append(headers.get(index).size).append('\n');
        }
        return builder.toString();
    }

    private String safePath(String raw) {
        String value = raw == null ? "" : raw.replace('\\', '/');
        StringBuilder out = new StringBuilder();
        String[] parts = value.split("/");
        for (int index = 0; index < parts.length; index++) {
            String part = parts[index].replaceAll("[\\x00-\\x1F]", "").replaceAll("[\\\\:*?\"<>|]", "_").trim();
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) continue;
            if (part.length() > 120) part = part.substring(0, 120);
            if (out.length() > 0) out.append('/');
            out.append(part);
        }
        return out.length() == 0 ? "AEM-file" : out.toString();
    }

    private String baseName(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? path : path.substring(slash + 1);
    }

    private File unique(File file) {
        if (!file.exists()) return file;
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        int index = 1;
        File candidate;
        do {
            candidate = new File(file.getParentFile(), base + " (" + (index++) + ")" + extension);
        } while (candidate.exists());
        return candidate;
    }

    private void copyFile(File source, File target) throws IOException {
        try (InputStream in = new BufferedInputStream(new FileInputStream(source), 256 * 1024);
             OutputStream out = new BufferedOutputStream(new FileOutputStream(target), 256 * 1024)) {
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) if (read > 0) out.write(buffer, 0, read);
        }
    }

    private int percent(long done, long total) {
        if (total <= 0L) return 0;
        return (int) Math.max(0L, Math.min(100L, done * 100L / total));
    }

    private String describe(Exception error) {
        String message = error == null ? null : error.getMessage();
        if (message == null || message.trim().isEmpty()) return "The connection ended unexpectedly.";
        return message;
    }

    private void sleep(long millis) {
        try { Thread.sleep(millis); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); }
    }

    // ------------------------------------------------------------------ selection

    private void showSelectionDialog() {
        if (selected.isEmpty()) {
            toast("Nothing is selected yet");
            return;
        }
        final LinearLayout rows = new LinearLayout(this);
        rows.setOrientation(LinearLayout.VERTICAL);
        rows.setPadding(dp(18), dp(6), dp(18), dp(4));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(rows, new ScrollView.LayoutParams(MATCH, WRAP));

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Selected items")
                .setView(scroll)
                .setPositiveButton("Done", null)
                .setNegativeButton("Clear all", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface ignored, int which) { clearSelection(); }
                })
                .create();
        fillSelectionRows(rows, dialog);
        dialog.show();
        styleDialog(dialog);
    }

    private void fillSelectionRows(final LinearLayout rows, final AlertDialog dialog) {
        rows.removeAllViews();
        ArrayList<Item> snapshot = new ArrayList<>(selected);
        for (int index = 0; index < snapshot.size(); index++) {
            final Item item = snapshot.get(index);
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, dp(8), 0, dp(8));

            LinearLayout texts = new LinearLayout(this);
            texts.setOrientation(LinearLayout.VERTICAL);
            TextView name = text(item.label(), 13f, ink());
            name.setTypeface(bold());
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            texts.addView(name);
            TextView meta = text(format(item.size) + (item.path.contains("/") ? " · " + item.path : ""), 10f, muted());
            meta.setSingleLine(true);
            meta.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            texts.addView(meta);
            row.addView(texts, new LinearLayout.LayoutParams(0, WRAP, 1f));

            TextView remove = text("×", 20f, secondary());
            remove.setGravity(Gravity.CENTER);
            remove.setBackground(rounded(sunken(), 14));
            remove.setClickable(true);
            remove.setFocusable(true);
            row.addView(remove, new LinearLayout.LayoutParams(dp(30), dp(30)));
            remove.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) {
                    removeItem(item);
                    updateBottomBar();
                    if (selected.isEmpty()) {
                        dialog.dismiss();
                        toast("Selection cleared");
                    } else {
                        fillSelectionRows(rows, dialog);
                    }
                }
            });

            rows.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));
            if (index < snapshot.size() - 1) rows.addView(divider());
        }
    }

    private void pickFiles() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, REQ_FILES);
        } catch (Exception error) {
            toast("No file picker is available on this phone");
        }
    }

    private void pickFolder() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, REQ_FOLDER);
        } catch (Exception error) {
            toast("No folder picker is available on this phone");
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;
        if (requestCode == REQ_FILES) {
            final ArrayList<Uri> picked = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int index = 0; index < clip.getItemCount(); index++) {
                    Uri uri = clip.getItemAt(index).getUri();
                    if (uri != null) picked.add(uri);
                }
            } else if (data.getData() != null) {
                picked.add(data.getData());
            }
            if (picked.isEmpty()) return;
            showBanner("Adding files", picked.size() + (picked.size() == 1 ? " file" : " files"), TONE_ACCENT, 0);
            io.execute(new Runnable() {
                @Override public void run() {
                    int added = 0;
                    for (int index = 0; index < picked.size(); index++) {
                        Item item = materializeUri(picked.get(index));
                        if (item != null) {
                            addItem(item);
                            added++;
                        }
                    }
                    final int count = added;
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            hideBanner();
                            if (count == 0) toast("Those files could not be read");
                            else toast(count + (count == 1 ? " file added" : " files added"));
                            if ("Files".equals(category)) render();
                            updateBottomBar();
                        }
                    });
                }
            });
        } else if (requestCode == REQ_FOLDER) {
            final Uri tree = data.getData();
            if (tree == null) return;
            try { getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
            catch (Exception ignored) { }
            showBanner("Adding folder", "Reading the folder structure…", TONE_ACCENT, 0);
            io.execute(new Runnable() {
                @Override public void run() {
                    final ArrayList<Item> found = new ArrayList<>();
                    addTree(tree, "", found);
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            hideBanner();
                            for (int index = 0; index < found.size(); index++) addItem(found.get(index));
                            toast(found.isEmpty() ? "The folder is empty" : found.size() + (found.size() == 1 ? " file added" : " files added"));
                            updateBottomBar();
                        }
                    });
                }
            });
        }
    }

    private Item materializeUri(Uri uri) {
        try {
            String name = displayName(uri);
            long size = sizeOf(uri);
            try {
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) { }
            if (size < 0L) {
                // Providers may not expose a size. Stage a copy so the wire protocol has exact lengths.
                File dir = new File(getCacheDir(), "aem-picked");
                if (!dir.exists() && !dir.mkdirs()) return null;
                File staged = new File(dir, UUID.randomUUID().toString().replace("-", "") + "-" + safePath(name));
                InputStream input = getContentResolver().openInputStream(uri);
                if (input == null) return null;
                try (InputStream in = new BufferedInputStream(input, 256 * 1024);
                     OutputStream out = new BufferedOutputStream(new FileOutputStream(staged), 256 * 1024)) {
                    byte[] buffer = new byte[256 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) if (read > 0) out.write(buffer, 0, read);
                }
                if (!staged.isFile()) return null;
                return Item.fromFile(staged, name);
            }
            return Item.fromUri(uri, name, size);
        } catch (Exception error) {
            return null;
        }
    }

    private void addTree(Uri tree, String relative, ArrayList<Item> out) {
        Cursor cursor = null;
        try {
            String documentId = DocumentsContract.getTreeDocumentId(tree);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
            String[] projection = {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE
            };
            cursor = getContentResolver().query(children, projection, null, null, null);
            if (cursor == null) return;
            int idColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE);
            while (cursor.moveToNext() && out.size() < MAX_ITEMS) {
                String document = cursor.getString(idColumn);
                String name = cursor.getString(nameColumn);
                String mime = cursor.getString(mimeColumn);
                Uri child = DocumentsContract.buildDocumentUriUsingTree(tree, document);
                String path = relative.isEmpty() ? name : relative + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    addTree(child, path, out);
                } else {
                    long size = cursor.isNull(sizeColumn) ? sizeOf(child) : cursor.getLong(sizeColumn);
                    if (size < 0L) {
                        Item staged = materializeUri(child);
                        if (staged != null) out.add(retarget(staged, path));
                    } else {
                        out.add(Item.fromUri(child, path, size));
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private Item retarget(Item staged, String path) {
        if (staged.file != null) return Item.fromFile(staged.file, path);
        return Item.fromUri(staged.uri, path, staged.size);
    }

    private String displayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                String name = cursor.getString(0);
                if (name != null && !name.trim().isEmpty()) return name;
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        String last = uri.getLastPathSegment();
        return last == null || last.trim().isEmpty() ? "AEM-file" : last;
    }

    private long sizeOf(Uri uri) {
        long value = -1L;
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null);
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                value = cursor.getLong(0);
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        try (android.content.res.AssetFileDescriptor descriptor = getContentResolver().openAssetFileDescriptor(uri, "r")) {
            long length = descriptor == null ? -1L : descriptor.getLength();
            if (length > 0L) return length;
            if (length == 0L && value < 0L) return 0L;
        } catch (Exception ignored) { }
        return value;
    }

    // ------------------------------------------------------------------ files

    private String mimeFor(File file) {
        String extension = extensionOf(file.getName());
        if ("apks".equals(extension) || "xapk".equals(extension) || "apkm".equals(extension)) {
            return "application/vnd.android.package-archive";
        }
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return mime == null ? "*/*" : mime;
    }

    private Uri uriFor(File file) {
        try {
            return FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
        } catch (Exception error) {
            return null;
        }
    }

    private void openTransferredFile(File file) {
        Uri uri = uriFor(file);
        if (uri == null) {
            toast("Cannot open " + file.getName() + " from this location");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mimeFor(file));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try { startActivity(intent); }
        catch (Exception error) { toast("No app can open " + file.getName()); }
    }

    private void shareTransferredFile(File file) {
        Uri uri = uriFor(file);
        if (uri == null) {
            toast("Cannot share " + file.getName() + " from this location");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType(mimeFor(file));
        intent.putExtra(Intent.EXTRA_STREAM, uri);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivity(Intent.createChooser(intent, "Share " + file.getName())); }
        catch (Exception error) { toast("No app can share this file"); }
    }

    private void confirmDelete(final File file) {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Delete file?")
                .setMessage(file.getName() + " will be removed from this phone. This cannot be undone.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Delete", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface ignored, int which) {
                        if (file.delete()) {
                            recordHistory("DELETED", file.getName(), 0L, "Removed");
                            toast("Deleted " + file.getName());
                            render();
                        } else {
                            toast("Could not delete " + file.getName());
                        }
                    }
                })
                .create();
        showDialog(dialog);
    }

    // ---- package installation ---------------------------------------------

    private boolean isPackageFile(File file) {
        String extension = extensionOf(file.getName());
        if ("apk".equals(extension) || "apks".equals(extension) || "xapk".equals(extension) || "apkm".equals(extension)) {
            return true;
        }
        return "zip".equals(extension) && archiveHasApk(file);
    }

    private boolean archiveHasApk(File file) {
        ZipFile zip = null;
        try {
            zip = new ZipFile(file);
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (!entry.isDirectory() && entry.getName().toLowerCase(Locale.US).endsWith(".apk")) return true;
            }
        } catch (Exception ignored) {
        } finally {
            try { if (zip != null) zip.close(); } catch (Exception ignored) { }
        }
        return false;
    }

    private String installedPackageFor(File file) {
        if (!"apk".equals(extensionOf(file.getName()))) return null;
        try {
            PackageInfo info = getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.GET_META_DATA);
            return info == null ? null : info.packageName;
        } catch (Exception error) {
            return null;
        }
    }

    private boolean isPackageInstalled(File file) {
        String packageName = installedPackageFor(file);
        if (packageName == null) return false;
        try { getPackageManager().getPackageInfo(packageName, 0); return true; }
        catch (Exception error) { return false; }
    }

    private void openInstalledPackage(File file) {
        String packageName = installedPackageFor(file);
        if (packageName == null) {
            openTransferredFile(file);
            return;
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(packageName);
        if (launch == null) {
            toast("Installed, but this app has no launch screen");
            return;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { startActivity(launch); }
        catch (Exception error) { toast("Could not open the installed app"); }
    }

    private boolean canInstallPackages() {
        return Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
    }

    private void installPackage(final File file) {
        if (!isPackageFile(file)) {
            openTransferredFile(file);
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !canInstallPackages()) {
            pendingInstall = file;
            AlertDialog installDialog = new AlertDialog.Builder(this)
                    .setTitle("Allow installs from AEM")
                    .setMessage("Android needs permission before AEM Transfer can hand an APK to the installer. You will be brought back here afterwards.")
                    .setNegativeButton("Cancel", new android.content.DialogInterface.OnClickListener() {
                        @Override public void onClick(android.content.DialogInterface ignored, int which) { pendingInstall = null; }
                    })
                    .setPositiveButton("Open settings", new android.content.DialogInterface.OnClickListener() {
                        @Override public void onClick(android.content.DialogInterface ignored, int which) {
                            try {
                                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                        Uri.parse("package:" + getPackageName())));
                            } catch (Exception error) {
                                toast("Open Settings → Apps → AEM → Install unknown apps");
                            }
                        }
                    })
                    .create();
            showDialog(installDialog);
            return;
        }
        installingName = file.getName();
        showBanner("Installing " + file.getName(), "Confirm with Android to finish", TONE_ACCENT, 0);
        io.execute(new Runnable() {
            @Override public void run() {
                try {
                    installNow(file);
                } catch (final Exception error) {
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            showBanner("Install failed", describe(error), TONE_DANGER, 7000);
                            recordHistory("FAILED", file.getName(), 0L, "Install failed");
                        }
                    });
                }
            }
        });
    }

    private void installNow(File file) throws Exception {
        ArrayList<File> apks = new ArrayList<>();
        File staging = null;
        try {
            if ("apk".equals(extensionOf(file.getName()))) {
                apks.add(file);
            } else {
                staging = new File(getCacheDir(), "aem-install-" + System.nanoTime());
                if (!staging.mkdirs()) throw new IOException("Cannot create an install staging folder");
                extractApks(file, staging, apks);
            }
            if (apks.isEmpty()) throw new IOException("No APK files were found inside " + file.getName());

            long total = 0L;
            for (int index = 0; index < apks.size(); index++) total += apks.get(index).length();
            PackageInstaller installer = getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                    PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            if (total > 0L) params.setSize(total);

            int sessionId = installer.createSession(params);
            PackageInstaller.Session session = installer.openSession(sessionId);
            try {
                byte[] buffer = new byte[256 * 1024];
                for (int index = 0; index < apks.size(); index++) {
                    File apk = apks.get(index);
                    try (InputStream in = new BufferedInputStream(new FileInputStream(apk), 256 * 1024);
                         OutputStream out = session.openWrite("apk-" + index + "-" + apk.getName(), 0, apk.length())) {
                        int read;
                        while ((read = in.read(buffer)) != -1) if (read > 0) out.write(buffer, 0, read);
                        session.fsync(out);
                    }
                }
                Intent callback = new Intent(ACTION_INSTALL_STATUS);
                callback.setPackage(getPackageName());
                callback.putExtra("aem_name", file.getName());
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                PendingIntent pending = PendingIntent.getBroadcast(this, 4300 + (sessionId % 100000), callback, flags);
                session.commit(pending.getIntentSender());
            } finally {
                session.close();
            }
        } finally {
            if (staging != null) deleteTree(staging);
        }
    }

    private void extractApks(File archive, File targetDir, ArrayList<File> out) throws IOException {
        ZipFile zip = null;
        try {
            zip = new ZipFile(archive);
            Enumeration<? extends ZipEntry> entries = zip.entries();
            byte[] buffer = new byte[256 * 1024];
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory() || !entry.getName().toLowerCase(Locale.US).endsWith(".apk")) continue;
                String name = new File(entry.getName()).getName();
                if (name.isEmpty()) continue;
                File output = new File(targetDir, "apk-" + out.size() + "-" + name);
                try (InputStream in = new BufferedInputStream(zip.getInputStream(entry), 256 * 1024);
                     OutputStream stream = new BufferedOutputStream(new FileOutputStream(output), 256 * 1024)) {
                    int read;
                    while ((read = in.read(buffer)) != -1) if (read > 0) stream.write(buffer, 0, read);
                }
                if (output.length() > 0L) out.add(output);
            }
        } finally {
            try { if (zip != null) zip.close(); } catch (Exception ignored) { }
        }
        if (out.isEmpty()) throw new IOException("No APK files were found inside " + archive.getName());
    }

    private void registerInstallReceiver() {
        installReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                String name = intent.getStringExtra("aem_name");
                if (name == null || name.trim().isEmpty()) name = installingName == null ? "Package" : installingName;
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        try { startActivity(confirm); }
                        catch (Exception error) { toast("Android could not show the install confirmation"); }
                    }
                } else if (status == PackageInstaller.STATUS_SUCCESS) {
                    recordHistory("INSTALLED", name, 0L, "Installed");
                    showBanner("Installed", name + " is ready to open.", TONE_SUCCESS, 6000);
                    if ("Downloads".equals(section)) render();
                } else {
                    String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                    showBanner("Install failed", message == null || message.isEmpty()
                            ? "Android rejected the package." : message, TONE_DANGER, 8000);
                    recordHistory("FAILED", name, 0L, "Install failed");
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_INSTALL_STATUS);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(installReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(installReceiver, filter);
    }

    // ------------------------------------------------------------------ history

    private synchronized void recordHistory(String action, String name, long size, String detail) {
        String safeName = name == null ? "" : name.replace('|', '/');
        String safeDetail = detail == null ? "" : detail.replace('|', '/');
        String line = System.currentTimeMillis() + "|" + action + "|" + safeName + "|" + size + "|" + safeDetail;
        String existing = prefs.getString(HISTORY_KEY, "");
        String combined = existing == null || existing.isEmpty() ? line : line + "\n" + existing;
        String[] lines = combined.split("\n");
        if (lines.length > 250) {
            StringBuilder trimmed = new StringBuilder();
            for (int index = 0; index < 250; index++) {
                if (index > 0) trimmed.append('\n');
                trimmed.append(lines[index]);
            }
            combined = trimmed.toString();
        }
        prefs.edit().putString(HISTORY_KEY, combined).apply();
    }

    private ArrayList<HistoryEntry> readHistory() {
        ArrayList<HistoryEntry> entries = new ArrayList<>();
        String raw = prefs.getString(HISTORY_KEY, "");
        if (raw == null || raw.trim().isEmpty()) return entries;
        String[] lines = raw.split("\n");
        for (int index = 0; index < lines.length && entries.size() < 250; index++) {
            String[] parts = lines[index].split("\\|", -1);
            if (parts.length < 5) continue;
            HistoryEntry entry = new HistoryEntry();
            try { entry.time = Long.parseLong(parts[0]); }
            catch (Exception error) { entry.time = 0L; }
            entry.action = parts[1] == null || parts[1].isEmpty() ? "INFO" : parts[1];
            entry.name = parts[2] == null || parts[2].isEmpty() ? "AEM Transfer" : parts[2];
            try { entry.size = Long.parseLong(parts[3]); }
            catch (Exception error) { entry.size = 0L; }
            entry.detail = parts[4];
            entries.add(entry);
        }
        return entries;
    }

    private void confirmClearHistory() {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Clear history?")
                .setMessage("The history is stored only on this phone. Received files are not deleted.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Clear", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface ignored, int which) {
                        prefs.edit().remove(HISTORY_KEY).apply();
                        render();
                    }
                })
                .create();
        showDialog(dialog);
    }

    private static final class HistoryEntry {
        long time;
        String action;
        String name;
        long size;
        String detail;
    }

    // ------------------------------------------------------------------ utilities

    private void finishWithConfirmation() {
        boolean busy = sendingNow.get() || (receiving && incomingBusy.get());
        if (!busy) {
            finish();
            return;
        }
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Transfer in progress")
                .setMessage("Leaving AEM Transfer now will stop the transfer. Partial data stays on both phones and can resume next time.")
                .setNegativeButton("Stay", null)
                .setPositiveButton("Leave", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface ignored, int which) { finish(); }
                })
                .create();
        showDialog(dialog);
    }

    @Override public void onBackPressed() {
        if (!"Transfer".equals(section)) {
            section = "Transfer";
            render();
            return;
        }
        if (nearby) {
            stopDiscovery();
            nearby = false;
            scanning = false;
            render();
            return;
        }
        if (receiveMode) {
            if (receiving || receivePreparing) {
                AlertDialog confirm = new AlertDialog.Builder(this)
                        .setTitle("Stop receiving?")
                        .setMessage("This phone will no longer be visible to nearby AEM phones.")
                        .setNegativeButton("Keep receiving", null)
                        .setPositiveButton("Stop", new android.content.DialogInterface.OnClickListener() {
                            @Override public void onClick(android.content.DialogInterface ignored, int which) { stopReceivingFlow(true); }
                        })
                        .create();
                showDialog(confirm);
            } else {
                receiveMode = false;
                render();
            }
            return;
        }
        if (sendingNow.get() || (receiving && incomingBusy.get())) {
            finishWithConfirmation();
            return;
        }
        finish();
    }

    private void toast(String message) {
        if (isFinishing()) return;
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private String readText(File file) {
        try (InputStream in = new FileInputStream(file)) {
            byte[] data = new byte[(int) Math.min(file.length(), 64 * 1024)];
            int offset = 0;
            while (offset < data.length) {
                int read = in.read(data, offset, data.length - offset);
                if (read < 0) break;
                offset += read;
            }
            return new String(data, 0, offset, StandardCharsets.UTF_8);
        } catch (Exception error) {
            return "";
        }
    }

    private void writeText(File file, String text) {
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    private void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (int index = 0; index < children.length; index++) deleteTree(children[index]);
        }
        file.delete();
    }
}
