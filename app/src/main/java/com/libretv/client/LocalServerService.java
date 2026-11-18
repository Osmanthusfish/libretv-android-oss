package com.libretv.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Owns Node independently of the WebView and replays the current state to a new Activity. */
public final class LocalServerService extends Service {
    private static final String CHANNEL = "libretv_local_server";
    private static final int NOTIFICATION_ID = 8899;
    private static final String STOP = "com.libretv.client.STOP_LOCAL_SERVER";
    private static final long CHECK_INTERVAL = 30000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService healthWorker = Executors.newSingleThreadExecutor();
    private final Binder binder = new ServerBinder();
    private LocalServer.Callback listener;
    private LocalServer server;
    private String message = "正在启动手机本地服务…";
    private String readyUrl;
    private String error;
    private int percent;
    private int port;
    private String password;
    private boolean lan;
    private boolean started;
    private boolean starting;
    private int generation;
    private int failedChecks;

    final class ServerBinder extends Binder {
        LocalServerService getService() { return LocalServerService.this; }
    }

    @Override public IBinder onBind(Intent intent) { return binder; }

    void attach(LocalServer.Callback callback) {
        listener = callback;
        if (error != null) callback.onError(error);
        else if (readyUrl != null) callback.onReady(readyUrl);
        else callback.onProgress(message, percent);
    }

    void detach(LocalServer.Callback callback) {
        if (listener == callback) listener = null;
    }

    LocalServer server() { return server; }

    boolean isActive() {
        return started && error == null
                && (starting || (readyUrl != null && server != null && server.isRunning()));
    }

    static Intent request(android.content.Context context, int port, String password,
                          boolean lan, boolean restart) {
        return new Intent(context, LocalServerService.class)
                .putExtra("port", port).putExtra("password", password).putExtra("lan", lan)
                .putExtra("restart", restart);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            shutdown();
            error = "本地服务已停止。";
            if (listener != null) listener.onError(error);
            stopSelf();
            return START_NOT_STICKY;
        }
        int requestedPort = intent.getIntExtra("port", 8899);
        String requestedPassword = intent.getStringExtra("password");
        boolean requestedLan = intent.getBooleanExtra("lan", false);
        if (requestedPassword == null || requestedPassword.isEmpty()) {
            shutdown();
            stopSelf();
            return START_NOT_STICKY;
        }

        enterForeground();
        if (!started || intent.getBooleanExtra("restart", false)
                || port != requestedPort || !requestedPassword.equals(password)
                || lan != requestedLan || (readyUrl == null && !starting)) {
            port = requestedPort;
            password = requestedPassword;
            lan = requestedLan;
            started = true;
            launch();
        }
        return START_REDELIVER_INTENT;
    }

    private void enterForeground() {
        Intent stop = new Intent(this, LocalServerService.class).setAction(STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 0, stop, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder notification;
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager.class).createNotificationChannel(
                    new NotificationChannel(CHANNEL, "LibreTV 本地服务", NotificationManager.IMPORTANCE_LOW));
            notification = new Notification.Builder(this, CHANNEL);
        } else {
            notification = new Notification.Builder(this).setPriority(Notification.PRIORITY_LOW);
        }
        Notification built = notification.setSmallIcon(R.drawable.ic_home)
                .setContentTitle("LibreTV 本地服务")
                .setContentText("支持播放与局域网投屏")
                .setOngoing(true).setContentIntent(open)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止服务", stopAction)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, built, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, built);
        }
    }

    private void launch() {
        final int attempt = ++generation;
        if (server != null) server.stop();
        main.removeCallbacks(checkHealth);
        readyUrl = null;
        error = null;
        starting = true;
        failedChecks = 0;
        updateProgress("正在启动手机本地服务…", 0);
        server = new LocalServer(this, new LocalServer.Callback() {
            @Override public void onProgress(String status, int value) {
                main.post(() -> { if (attempt == generation) updateProgress(status, value); });
            }
            @Override public void onReady(String url) {
                main.post(() -> {
                    if (attempt != generation) return;
                    starting = false;
                    readyUrl = url;
                    main.postDelayed(checkHealth, CHECK_INTERVAL);
                    if (listener != null) listener.onReady(url);
                });
            }
            @Override public void onError(String failure) {
                main.post(() -> {
                    if (attempt != generation) return;
                    shutdown();
                    error = failure;
                    if (listener != null) listener.onError(failure);
                    stopSelf();
                });
            }
        });
        server.start(port, password, lan);
    }

    private void updateProgress(String status, int value) {
        message = status;
        percent = value;
        if (listener != null) listener.onProgress(status, value);
    }

    private final Runnable checkHealth = this::checkHealth;

    private void checkHealth() {
        if (readyUrl == null) return;
        final LocalServer current = server;
        final String url = readyUrl;
        final int attempt = generation;
        healthWorker.execute(() -> {
            boolean running = current.isRunning();
            boolean healthy = running && responds(url);
            main.post(() -> {
                if (attempt != generation) return;
                failedChecks = healthy ? 0 : failedChecks + 1;
                if (!running || failedChecks >= 3) {
                    AppLog.get(this).w("server", "本地服务健康检查失败，正在重启 Node");
                    launch();
                } else {
                    main.postDelayed(checkHealth, CHECK_INTERVAL);
                }
            });
        });
    }

    private static boolean responds(String origin) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/api/status").openConnection(Proxy.NO_PROXY);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            return connection.getResponseCode() == 200;
        } catch (java.io.IOException e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void shutdown() {
        generation++;
        started = false;
        starting = false;
        readyUrl = null;
        main.removeCallbacks(checkHealth);
        if (server != null) server.stop();
        stopForeground(true);
    }

    @Override public void onDestroy() {
        shutdown();
        listener = null;
        healthWorker.shutdownNow();
        super.onDestroy();
    }
}
