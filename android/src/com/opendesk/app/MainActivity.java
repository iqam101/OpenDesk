package com.opendesk.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.util.SparseArray;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * OpenDesk for Android: a WebView showing the same UI as the Windows app (assets/web),
 * plus the small native pieces the page cannot do itself (saving files, clipboard, file picker).
 */
public class MainActivity extends Activity {
    private static final String TAG = "OpenDesk";
    /** The UI is served from the APK's assets under this made-up HTTPS origin (never resolved on the network). */
    private static final String HOST = "app.opendesk.invalid";
    private static final int PICK_FILES = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private ClipboardManager clipboard;
    private boolean immersive, clipWatching;
    private String clipSeen = "";
    private final SparseArray<Sink> sinks = new SparseArray<>();
    private int nextHandle = 1;

    private final ClipboardManager.OnPrimaryClipChangedListener clipListener = this::pushClip;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "OpenDeskNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.loadUrl("https://" + HOST + "/");
    }

    @Override
    protected void onDestroy() {
        clipboard.removePrimaryClipChangedListener(clipListener);
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.OpenDeskMobile && OpenDeskMobile.onBack()) === true", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            if (immersive) applyImmersive();
            pushClip();  // Android only lets the focused app read the clipboard
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || fileCallback == null) return;
        Uri[] out = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                out = new Uri[clip.getItemCount()];
                for (int i = 0; i < out.length; i++) out[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(out);
        fileCallback = null;
    }

    private void applyImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(immersive
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    private String clipText() {
        try {
            ClipData c = clipboard.getPrimaryClip();
            if (c == null || c.getItemCount() == 0) return "";
            CharSequence t = c.getItemAt(0).coerceToText(this);
            return t == null ? "" : t.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** Tell the page when this device's clipboard text changed (only while a session asked for it). */
    private void pushClip() {
        if (!clipWatching) return;
        String t = clipText();
        if (t.isEmpty() || t.equals(clipSeen) || t.length() > 200000) return;
        clipSeen = t;
        web.evaluateJavascript("window.OpenDeskMobile && OpenDeskMobile.onClip(" + JSONObject.quote(t) + ")", null);
    }

    // ------------------------------------------------------------------ page loading
    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath() == null ? "/" : u.getPath();
            String name = path.equals("/") ? "index.html" : path.startsWith("/static/") ? path.substring(8) : null;
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            if (name != null && !name.contains("..")) {
                try {
                    InputStream in = getAssets().open("web/" + name);
                    String mime = mime(name);
                    return new WebResourceResponse(mime, mime.startsWith("image/png") ? null : "utf-8", 200, "OK", headers, in);
                } catch (IOException e) {
                    Log.w(TAG, "asset not found: " + name);
                }
            }
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !HOST.equals(request.getUrl().getHost());  // never leave the app's own page
        }
    }

    private static String mime(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(Intent.createChooser(i, "Choose files to send"), PICK_FILES);
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.message() + " @ " + m.sourceId() + ":" + m.lineNumber());
            return true;
        }
    }

    // ------------------------------------------------------------------ called from mobile.js
    private class Bridge {
        @JavascriptInterface
        public String deviceName() {
            String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER, model = Build.MODEL == null ? "" : Build.MODEL;
            String n = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : (maker + " " + model).trim();
            return n.isEmpty() ? "Android device" : n;
        }

        @JavascriptInterface
        public void clipSet(final String text) {
            runOnUiThread(() -> {
                try {
                    clipSeen = text;
                    clipboard.setPrimaryClip(ClipData.newPlainText("OpenDesk", text));
                } catch (Exception e) {
                    Log.w(TAG, "clipboard write failed", e);
                }
            });
        }

        @JavascriptInterface
        public void clipWatch(final boolean on) {
            runOnUiThread(() -> {
                clipboard.removePrimaryClipChangedListener(clipListener);
                clipWatching = on;
                if (on) {
                    clipSeen = clipText();  // only changes made from now on are sent
                    clipboard.addPrimaryClipChangedListener(clipListener);
                }
            });
        }

        @JavascriptInterface
        public void fullscreen() {
            runOnUiThread(() -> {
                immersive = !immersive;
                applyImmersive();
            });
        }

        @JavascriptInterface
        public int fileOpen(String name) {
            try {
                Sink s = Sink.create(MainActivity.this, name, false);
                synchronized (sinks) {
                    int h = nextHandle++;
                    sinks.put(h, s);
                    return h;
                }
            } catch (Exception e) {
                Log.e(TAG, "fileOpen failed", e);
                return -1;
            }
        }

        @JavascriptInterface
        public boolean fileWrite(int h, String b64) {
            Sink s;
            synchronized (sinks) {
                s = sinks.get(h);
            }
            if (s == null) return false;
            try {
                s.out.write(Base64.decode(b64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "fileWrite failed", e);
                return false;
            }
        }

        /** Returns where the file was saved, or "" when it was discarded or could not be saved. */
        @JavascriptInterface
        public String fileClose(int h, boolean ok) {
            Sink s;
            synchronized (sinks) {
                s = sinks.get(h);
                sinks.remove(h);
            }
            return s == null ? "" : s.finish(ok);
        }

        @JavascriptInterface
        public String saveImage(String b64, String name) {
            try {
                Sink s = Sink.create(MainActivity.this, name, true);
                boolean ok = true;
                try {
                    s.out.write(Base64.decode(b64, Base64.DEFAULT));
                } catch (Exception e) {
                    ok = false;
                }
                return s.finish(ok);
            } catch (Exception e) {
                Log.e(TAG, "saveImage failed", e);
                return "";
            }
        }
    }

    /** A file being written to Download/OpenDesk (or Pictures/OpenDesk for screenshots). */
    private static class Sink {
        OutputStream out;
        ContentResolver resolver;
        Uri uri;
        File file;
        String shown;

        static Sink create(Context c, String name, boolean image) throws IOException {
            name = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
            if (name.isEmpty()) name = "file";
            Sink s = new Sink();
            String folder = image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                if (image) v.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/OpenDesk");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri base = image
                        ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                        : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                s.resolver = c.getContentResolver();
                s.uri = s.resolver.insert(base, v);
                if (s.uri == null) throw new IOException("MediaStore refused the file");
                OutputStream raw = s.resolver.openOutputStream(s.uri);
                if (raw == null) {
                    s.resolver.delete(s.uri, null, null);
                    throw new IOException("Cannot open the new file");
                }
                s.out = new BufferedOutputStream(raw, 1 << 16);
                s.shown = folder + "/OpenDesk/" + name;
            } else {
                // Android 9 and older: the app's own folder needs no storage permission.
                File dir = new File(c.getExternalFilesDir(folder), "OpenDesk");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
                File f = new File(dir, name);
                int dot = name.lastIndexOf('.');
                for (int i = 1; f.exists(); i++) {
                    f = new File(dir, dot > 0 ? name.substring(0, dot) + " (" + i + ")" + name.substring(dot) : name + " (" + i + ")");
                }
                s.file = f;
                s.out = new BufferedOutputStream(new FileOutputStream(f), 1 << 16);
                s.shown = f.getAbsolutePath();
            }
            return s;
        }

        String finish(boolean ok) {
            try {
                out.close();
            } catch (IOException e) {
                ok = false;
            }
            try {
                if (uri != null) {
                    if (ok) {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        resolver.update(uri, v, null, null);
                    } else {
                        resolver.delete(uri, null, null);
                    }
                } else if (!ok && file != null) {
                    file.delete();
                }
            } catch (Exception e) {
                Log.e(TAG, "finish failed", e);
                return "";
            }
            return ok ? shown : "";
        }
    }
}
