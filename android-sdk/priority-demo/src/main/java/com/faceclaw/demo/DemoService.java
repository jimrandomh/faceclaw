package com.faceclaw.demo;

import android.content.ComponentName;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Handler;
import android.os.Looper;
import com.faceclaw.sdk.FaceclawAppService;
import com.faceclaw.sdk.Protocol;
import com.faceclaw.sdk.Ui;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** A real SDK client with deterministic, local-only providers and optional failure controls. */
public final class DemoService extends FaceclawAppService {
  static DemoService instance;
  private final Handler main = new Handler(Looper.getMainLooper());
  private SharedPreferences prefs;
  // Surface epochs belong to individual features, not the overall snapshot revision.
  private final Map<String, View> surfaces = new HashMap<>();
  private final Map<String, Request> requests = new HashMap<>();
  private View window;
  private JSONArray apps = new JSONArray(), menu = new JSONArray();
  private String menuTitle = "App actions";
  private final SharedPreferences.OnSharedPreferenceChangeListener settingsChanged =
      (store, key) -> {
        publishExtensions(DemoSettings.declarations(store));
        DemoState.log("Local settings changed: " + key);
        renderAll();
      };

  private static final class View {
    int width, height, selected;
    long epoch;
    boolean visible, awake;

    View(JSONObject data) {
      width = data.optInt("width");
      height = data.optInt("height");
      epoch = data.optLong("extensionGeneration");
    }
  }

  private final class Request {
    final String feature, id, mode;
    final long epoch;
    Runnable response, expiry;

    Request(String feature, String id, long epoch) {
      this.feature = feature;
      this.id = id;
      this.epoch = epoch;
      mode = prefs.getString("mode", "normal");
    }

    void clear() {
      if (response != null) main.removeCallbacks(response);
      if (expiry != null) main.removeCallbacks(expiry);
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    prefs = DemoSettings.preferences(this);
    prefs.registerOnSharedPreferenceChangeListener(settingsChanged);
  }

  @Override
  public void onDestroy() {
    prefs.unregisterOnSharedPreferenceChangeListener(settingsChanged);
    cancelAll();
    instance = null;
    super.onDestroy();
  }

  @Override
  protected void onHostConnected() {
    DemoState.connected = true;
    DemoState.log("Host connected");
    publishExtensions(DemoSettings.declarations(prefs));
  }

  @Override
  protected void onHostDisconnected() {
    DemoState.connected = false;
    DemoState.log("Host disconnected; snapshot is last known");
    cancelAll();
    surfaces.clear();
    window = null;
    apps = new JSONArray();
    menu = new JSONArray();
  }

  // A disconnected session never carries requests, catalogs or surfaces into the next one.
  private void cancelAll() {
    for (Request request : requests.values()) request.clear();
    requests.clear();
  }

  private JSONObject feature(String name) {
    JSONArray values = extensions().optJSONArray("features");
    if (values != null)
      for (int i = 0; i < values.length(); i++) {
        JSONObject item = values.optJSONObject(i);
        if (item != null && name.equals(item.optString("feature"))) return item;
      }
    return new JSONObject();
  }

  private boolean owns(String name, long epoch) {
    JSONObject state = feature(name);
    return DemoState.connected
        && state.optBoolean("available")
        && state.optLong("generation", -1) == epoch
        && new ComponentName(this, DemoService.class)
            .flattenToString()
            .equals(state.optString("component"));
  }

  @Override
  protected void onHostEvent(String type, JSONObject data) {
    if (type.equals("extensions")) {
      JSONArray previous = DemoState.snapshot.optJSONArray("features"),
          next = extensions().optJSONArray("features");
      if (next != null)
        for (int i = 0; i < next.length(); i++) {
          JSONObject state = next.optJSONObject(i), before = null;
          if (state == null) continue;
          if (previous != null)
            for (int n = 0; n < previous.length(); n++) {
              JSONObject value = previous.optJSONObject(n);
              if (value != null && state.optString("feature").equals(value.optString("feature")))
                before = value;
            }
          if (before == null || before.optLong("generation") != state.optLong("generation")) {
            String owner = state.optString("component");
            DemoState.log(
                state.optString("feature")
                    + " -> "
                    + (owner.isEmpty() ? "host" : owner.split("/", 2)[0])
                    + " ("
                    + (state.optBoolean("available") ? "effective" : "host fallback")
                    + ", epoch "
                    + state.optLong("generation")
                    + ")");
          }
        }
      DemoState.snapshot = extensions();
      // Metadata changes to another contender must not reset our unchanged live work.
      surfaces.entrySet().removeIf(entry -> !owns(entry.getKey(), entry.getValue().epoch));
      for (Request request : new java.util.ArrayList<>(requests.values()))
        if (!owns(request.feature, request.epoch)) cancel(request);
      renderAll();
      return;
    }
    if (type.equals("shared-style")) {
      renderAll();
      return;
    }
    if (type.equals("open") || type.equals("resize")) {
      window = new View(data);
      return;
    }
    if (type.equals("close")) {
      window = null;
      return;
    }
    if (type.equals("visibility") && window != null) {
      window.visible = data.optBoolean("visible");
      window.awake = data.optBoolean("screenOn");
      renderWindow();
      return;
    }
    if (type.equals("render")) {
      renderWindow();
      return;
    }
    if (type.equals("input")) {
      if (data.optString("type").equals("long-press")) requestSystemMenu();
      return;
    }
    if (type.equals("extension-surface")) {
      String name = data.optString("feature"), operation = data.optString("type");
      if (operation.equals("open") || operation.equals("resize"))
        surfaces.put(name, new View(data));
      View view = surfaces.get(name);
      if (operation.equals("close")) surfaces.remove(name);
      if (operation.equals("visibility") && view != null) {
        view.visible = data.optBoolean("visible");
        view.awake = data.optBoolean("screenOn");
        renderSurface(name, view);
      }
      return;
    }
    if (!type.equals("extension-event")) return;
    String name = data.optString("feature"), operation = data.optString("type");
    long epoch = data.optLong("generation");
    JSONObject payload = data.optJSONObject("data");
    if (payload == null) return;
    String id = payload.optString("requestId"), key = name + ":" + id;
    if (operation.equals("cancel")) {
      Request request = requests.get(key);
      if (request != null && request.epoch == epoch) cancel(request);
      return;
    }
    if (!owns(name, epoch)) return;
    if (operation.equals("request")
        && name.equals("ui.launcher")
        && payload.optString("operation").equals("folder-tool")) {
      respondExtension(
          name,
          epoch,
          id,
          Protocol.object("ok", false, "error", "The demo launcher does not manage folders."));
      return;
    }
    if (operation.equals("request")
        && java.util.Arrays.asList("assistant", "transcription", "refinement").contains(name)) {
      if (!validRequestId(id) || requests.containsKey(key)) return;
      if (requests.size() >= 16) {
        respondExtension(
            name, epoch, id, Protocol.object("error", "demo_capacity", "dispatched", false));
        return;
      }
      Request request = new Request(name, id, epoch);
      requests.put(key, request);
      DemoState.log(name + " request accepted (" + request.mode + ")");
      // Bound even deliberately silent probes; retain only request metadata, never input content.
      request.expiry =
          () -> {
            requests.remove(key, request);
            request.clear();
          };
      main.postDelayed(request.expiry, 650000);
      if (!name.equals("transcription") || request.mode.equals("unavailable")) respond(request);
      return;
    }
    if (operation.equals("event")
        && name.equals("transcription")
        && payload.optString("event").equals("finish")) {
      Request request = requests.get(key);
      if (request != null && request.epoch == epoch) respond(request);
      return;
    }
    if (operation.equals("event")
        && payload.optString("event").equals("host-state")
        && name.equals("ui.launcher")) {
      JSONArray values = payload.optJSONArray("apps");
      apps = values == null ? new JSONArray() : values;
      renderAll();
      return;
    }
    if (operation.equals("event")
        && payload.optString("event").equals("menu")
        && name.equals("ui.app-menu")) {
      menuTitle = payload.optString("title", "App actions");
      JSONArray values = payload.optJSONArray("items");
      menu = values == null ? new JSONArray() : values;
      renderAll();
      return;
    }
    if (operation.equals("input")) {
      JSONObject input = payload.optJSONObject("input");
      if (input != null) input(name, epoch, input);
    }
    // Real notification payloads and microphone audio are deliberately ignored and never logged.
  }

  private static boolean validRequestId(String value) {
    return com.faceclaw.sdk.ExtensionContract.token(value);
  }

  // A callId identifies one action attempt. Submission does not imply that the host accepted it.
  private void performAction(String feature, long epoch, String action, JSONObject data) {
    try {
      data.put("callId", java.util.UUID.randomUUID().toString());
      invokeExtensionAction(feature, epoch, action, data);
    } catch (org.json.JSONException ignored) {
      /* Locally constructed payloads only. */
    }
  }

  private void respond(Request request) {
    if (request.response != null || request.mode.equals("silent")) return;
    request.response =
        () -> {
          if (requests.remove(request.feature + ":" + request.id) != request) return;
          request.clear();
          JSONObject result =
              request.mode.equals("unavailable")
                  ? Protocol.object("error", "demo_unavailable", "dispatched", false)
                  : Protocol.object(
                      "text",
                      BuildConfig.DEMO_NAME
                          + " synthetic "
                          + request.feature
                          + " response. No backend was contacted.",
                      "stopReason",
                      "end_turn",
                      "dispatched",
                      true);
          respondExtension(request.feature, request.epoch, request.id, result);
          DemoState.log(request.feature + " response attempted at epoch " + request.epoch);
        };
    long delay = request.mode.equals("late") ? 15000 : request.mode.equals("delay") ? 10000 : 0;
    main.postDelayed(request.response, delay);
  }

  /** Normal requests cancel immediately. Only the explicit late-reply probe violates this rule. */
  private void cancel(Request request) {
    // Exercise stale-authority rejection in the host; do not copy this exception into real
    // providers.
    if (request.mode.equals("late") && request.response != null) {
      DemoState.log(request.feature + " cancellation received; late probe retained");
      return;
    }
    requests.remove(request.feature + ":" + request.id);
    request.clear();
    DemoState.log(request.feature + " cancelled");
  }

  private void input(String name, long epoch, JSONObject input) {
    View view = surfaces.get(name);
    if (view == null) return;
    String type = input.optString("type");
    JSONArray rows = name.equals("ui.launcher") ? apps : menu;
    int count = name.equals("ui.notifications") ? 1 : rows.length();
    if (type.equals("scroll-down"))
      view.selected = Math.min(Math.max(0, count - 1), view.selected + 1);
    else if (type.equals("scroll-up")) view.selected = Math.max(0, view.selected - 1);
    else if (type.equals("back") || type.equals("double-click"))
      performAction(name, epoch, "close-surface", new JSONObject());
    else if (type.equals("click") || type.equals("pointer-click")) {
      if (type.equals("pointer-click")) {
        int y = input.optInt("y"), index = (y - 50) / rowHeight() + firstRow(view);
        if (y < 50 || y >= view.height - 8 || index < 0 || index >= count) return;
        view.selected = index;
      }
      JSONObject row = rows.optJSONObject(view.selected);
      if (name.equals("ui.notifications"))
        performAction(name, epoch, "close-surface", new JSONObject());
      else if (row != null && name.equals("ui.launcher"))
        performAction(name, epoch, "open-app", Protocol.object("appId", row.optString("appId")));
      else if (row != null && row.optBoolean("enabled", true))
        performAction(name, epoch, "menu-select", Protocol.object("token", row.optString("token")));
    }
    renderSurface(name, view);
  }

  private int rowHeight() {
    return Math.max(26, (int) Ui.style().fontSize(28));
  }

  private int firstRow(View view) {
    int capacity = Math.max(1, (view.height - 70) / rowHeight());
    return (view.selected / capacity) * capacity;
  }

  private void renderAll() {
    renderWindow();
    for (Map.Entry<String, View> entry : surfaces.entrySet())
      renderSurface(entry.getKey(), entry.getValue());
  }

  private Bitmap background(View view, String title) {
    Bitmap bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(bitmap);
    canvas.drawColor(Color.BLACK);
    Paint border = new Paint();
    border.setColor(Color.WHITE);
    border.setStyle(Paint.Style.STROKE);
    border.setStrokeWidth(Ui.style().borderWidth(2));
    canvas.drawRoundRect(
        5,
        5,
        view.width - 5,
        view.height - 5,
        Ui.style().cornerRadius(4),
        Ui.style().cornerRadius(4),
        border);
    Ui.text(canvas, title, 16, 32, 18, Color.WHITE);
    return bitmap;
  }

  private void renderWindow() {
    if (window == null || !window.visible || !window.awake || !prefs.getBoolean("frames", true))
      return;
    Bitmap bitmap = background(window, BuildConfig.DEMO_NAME + " / shared style");
    try {
      Canvas canvas = new Canvas(bitmap);
      int y = 66;
      String[] lines = {
        "The quick brown fox jumps over the lazy dog.",
        "0123456789  /  Aa Bb Cc  /  [] ()",
        "Effective font size: " + Ui.style().size + " px",
        "Settings and priority controls are on your phone.",
        "System escape gestures remain host-owned."
      };
      Paint paint = Ui.style().textPaint(16, Color.WHITE);
      for (String line : lines)
        for (String wrapped : Ui.wrap(line, paint, Math.max(1, window.width - 32))) {
          if (y > window.height - 16) break;
          canvas.drawText(wrapped, 16, y, paint);
          y += rowHeight();
        }
      submitBitmap(bitmap);
    } finally {
      bitmap.recycle();
    }
  }

  private void renderSurface(String name, View view) {
    if (!view.visible
        || !view.awake
        || !prefs.getBoolean("frames", true)
        || !owns(name, view.epoch)) return;
    Bitmap bitmap =
        background(
            view,
            BuildConfig.DEMO_NAME
                + " / "
                + (name.equals("ui.app-menu") ? menuTitle : name.substring(3)));
    try {
      Canvas canvas = new Canvas(bitmap);
      if (name.equals("ui.notifications")) {
        Ui.text(canvas, "Synthetic notification surface", 16, 70, 16, Color.WHITE);
        Ui.text(
            canvas, "Tap to close. No real message content is shown.", 16, 102, 14, Color.WHITE);
      } else {
        JSONArray rows = name.equals("ui.launcher") ? apps : menu;
        view.selected = Math.max(0, Math.min(view.selected, rows.length() - 1));
        int y = 50, first = firstRow(view);
        for (int i = first; i < rows.length() && y + rowHeight() < view.height - 8; i++) {
          JSONObject row = rows.optJSONObject(i);
          if (row == null) continue;
          if (i == view.selected) {
            Paint selection = new Paint();
            selection.setColor(Color.WHITE);
            canvas.drawRect(12, y, view.width - 12, y + rowHeight() - 2, selection);
          }
          Paint text = Ui.style().textPaint(16, i == view.selected ? Color.BLACK : Color.WHITE);
          String label = row.optString(name.equals("ui.launcher") ? "title" : "label");
          int fit = text.breakText(label, true, Math.max(1, view.width - 40), null);
          canvas.drawText(label.substring(0, fit), 20, y + rowHeight() - 8, text);
          y += rowHeight();
        }
        if (rows.length() == 0)
          Ui.text(canvas, "Waiting for the host catalog...", 16, 75, 16, Color.WHITE);
      }
      submitExtensionBitmap(name, bitmap);
    } finally {
      bitmap.recycle();
    }
  }
}
