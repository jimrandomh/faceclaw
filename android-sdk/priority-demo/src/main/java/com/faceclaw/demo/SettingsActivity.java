package com.faceclaw.demo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Public entry points open this screen only. Intent extras never configure or approve anything. */
public final class SettingsActivity extends Activity {
  private SharedPreferences prefs;
  private LinearLayout content;
  private TextView connection, status, events, inspector;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Runnable refresh =
      new Runnable() {
        public void run() {
          refreshStatus();
          main.postDelayed(this, 700);
        }
      };
  private boolean bound;
  private final ServiceConnection local =
      new ServiceConnection() {
        public void onServiceConnected(ComponentName name, IBinder binder) {
          refreshStatus();
        }

        public void onServiceDisconnected(ComponentName name) {
          refreshStatus();
        }
      };

  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    prefs = DemoSettings.preferences(this);
    int systemBars = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    if (android.os.Build.VERSION.SDK_INT >= 26)
      systemBars |= android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    getWindow().getDecorView().setSystemUiVisibility(systemBars);
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setBackgroundColor(Color.rgb(246, 247, 249));
    content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(dp(20), dp(16), dp(20), dp(24));
    scroll.addView(content);
    setContentView(scroll);
    scroll.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          view.setPadding(
              0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
          return insets;
        });
    heading("Faceclaw " + BuildConfig.DEMO_NAME);
    text(
        BuildConfig.PROFILE_A
            ? "Profile A: Inter 18 px, crisp text, rounded borders and centered layout."
            : "Profile B: Roboto 14 px, antialiased text, square borders and persistent sidebar.");
    connection = text("");
    button("Faceclaw permissions and priority", this::openHost);
    button("Inspect live priorities", this::inspect);
    text(
        "Approve this app and select a host, then grant features and set their order in Faceclaw."
            + " Installing or enabling a declaration does not grant control.");
    buildDeclarations();
    buildAdvancedTesting();
    heading("Effective state reported by host");
    status = text("");
    text(
        "Selected owner and availability are separate. Live outage keeps the selection and uses"
            + " host behavior. Disable, revoke or uninstall to promote the next eligible"
            + " contender.");
    heading("Event log (this process)");
    events = text("");
    events.setTextSize(12);
    button(
        "Clear event log",
        () -> {
          DemoState.events.clear();
          refreshStatus();
        });
    bound = bindService(new Intent(this, DemoService.class), local, Context.BIND_AUTO_CREATE);
  }

  private void buildDeclarations() {
    heading("Declarations");
    toggle("Enable this app's overrides", "enabled", true);
    for (int i = 0; i < DemoSettings.FEATURES.length; i++)
      toggle(
          DemoSettings.LABELS[i],
          DemoSettings.FEATURES[i],
          DemoSettings.enabled(prefs, DemoSettings.FEATURES[i]));
    text(
        "Live surfaces are optional. The notification surface uses synthetic copy. Providers return"
            + " canned text and never contact a backend or save prompts/audio.");
  }

  private void buildAdvancedTesting() {
    LinearLayout advanced = new LinearLayout(this);
    advanced.setOrientation(LinearLayout.VERTICAL);
    advanced.setVisibility(android.view.View.GONE);
    Button expand = button("Advanced testing ▸", () -> {});
    expand.setOnClickListener(
        view -> {
          boolean show = advanced.getVisibility() != android.view.View.VISIBLE;
          advanced.setVisibility(show ? android.view.View.VISIBLE : android.view.View.GONE);
          expand.setText(show ? "Advanced testing ▾" : "Advanced testing ▸");
        });
    content.addView(advanced);
    text(
        advanced,
        "Optional failure probes for synthetic test work. Normal SDK clients should honor"
            + " cancellation and continue delivering frames.");
    toggle(advanced, "Typography requires this app's launcher", "requiresLauncher", false);
    text(
        advanced,
        "Dependency test: typography becomes eligible only when this app also wins launcher. It"
            + " becomes unavailable while that live dependency is offline.");
    toggle(advanced, "Withdraw all declarations", "withdraw", false);
    text(
        advanced,
        "Withdrawal removes this app from the contender lists. Turning it off republishes the"
            + " declarations. Grants and priority remain host-owned.");
    heading(advanced, "Failure controls");
    text(advanced, "Behavior for new synthetic assistant, transcription and refinement requests:");
    Spinner mode = new Spinner(this);
    ArrayAdapter<String> options =
        new ArrayAdapter<>(
            this, android.R.layout.simple_spinner_dropdown_item, DemoSettings.MODE_LABELS);
    mode.setAdapter(options);
    int selected =
        java.util.Arrays.asList(DemoSettings.MODES).indexOf(prefs.getString("mode", "normal"));
    mode.setSelection(Math.max(0, selected));
    mode.setOnItemSelectedListener(
        new android.widget.AdapterView.OnItemSelectedListener() {
          public void onNothingSelected(android.widget.AdapterView<?> parent) {}

          public void onItemSelected(
              android.widget.AdapterView<?> parent, android.view.View view, int position, long id) {
            if (!DemoSettings.MODES[position].equals(prefs.getString("mode", "normal")))
              prefs.edit().putString("mode", DemoSettings.MODES[position]).apply();
          }
        });
    advanced.addView(mode, new LinearLayout.LayoutParams(-1, dp(52)));
    toggle(advanced, "Deliver frames to the host", "frames", true);
    text(
        advanced,
        "Turn frames off to test a connected but unresponsive renderer. Use the host's system"
            + " escape gesture to recover. Silent providers use the normal host deadlines; use"
            + " Cancel for a shorter test.");
    button(
        advanced,
        "Crash this demo process",
        () ->
            new AlertDialog.Builder(this)
                .setTitle("Crash " + BuildConfig.DEMO_NAME + "?")
                .setMessage(
                    "This screen closes. Faceclaw may reconnect after about five seconds."
                        + " Independent static settings should persist; live features use host"
                        + " fallback during the outage.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton(
                    "Crash demo",
                    (d, w) -> android.os.Process.killProcess(android.os.Process.myPid()))
                .show());
    button(
        advanced,
        "Open Android app details",
        () ->
            startActivity(
                new Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:" + getPackageName()))));
  }

  @Override
  protected void onResume() {
    super.onResume();
    main.post(refresh);
  }

  @Override
  protected void onPause() {
    main.removeCallbacks(refresh);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    if (bound) unbindService(local);
    super.onDestroy();
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private TextView text(String value) {
    return text(content, value);
  }

  private TextView text(LinearLayout parent, String value) {
    TextView view = new TextView(this);
    view.setText(value);
    view.setTextColor(Color.rgb(38, 43, 52));
    view.setTextSize(15);
    view.setPadding(0, dp(6), 0, dp(10));
    parent.addView(view);
    return view;
  }

  private void heading(String value) {
    heading(content, value);
  }

  private void heading(LinearLayout parent, String value) {
    TextView view = text(parent, value);
    view.setTextSize(22);
    view.setTypeface(null, android.graphics.Typeface.BOLD);
    view.setPadding(0, dp(18), 0, dp(6));
  }

  private Button button(String label, Runnable action) {
    return button(content, label, action);
  }

  private Button button(LinearLayout parent, String label, Runnable action) {
    Button button = new Button(this);
    button.setText(label);
    button.setAllCaps(false);
    button.setOnClickListener(v -> action.run());
    parent.addView(button, new LinearLayout.LayoutParams(-1, dp(52)));
    return button;
  }

  private void toggle(String label, String key, boolean fallback) {
    toggle(content, label, key, fallback);
  }

  private void toggle(LinearLayout parent, String label, String key, boolean fallback) {
    CheckBox box = new CheckBox(this);
    box.setText(label);
    box.setTextSize(16);
    box.setMinHeight(dp(48));
    box.setChecked(prefs.getBoolean(key, fallback));
    box.setOnCheckedChangeListener((button, value) -> prefs.edit().putBoolean(key, value).apply());
    parent.addView(box);
  }

  private void refreshStatus() {
    if (connection == null) return;
    DemoService service = DemoService.instance;
    String host = service == null ? "" : service.selectedHostLabel();
    updateText(
        connection,
        (DemoState.connected ? "Connected" : "Disconnected")
            + (host.isEmpty() ? " · no selected host" : " · " + host)
            + "\n"
            + getPackageName());
    StringBuilder description =
        new StringBuilder(
            DemoState.connected ? "Current snapshot" : "Last known snapshot (offline)");
    description
        .append(" · revision ")
        .append(DemoState.snapshot.optLong("generation", 0))
        .append("\n");
    JSONArray features = DemoState.snapshot.optJSONArray("features");
    if (features == null) description.append("Waiting for host approval and connection.");
    else
      for (int i = 0; i < features.length(); i++) {
        JSONObject feature = features.optJSONObject(i);
        if (feature == null) continue;
        JSONArray contenders = feature.optJSONArray("contenders");
        if (contenders == null || contenders.length() == 0) continue;
        description
            .append("\n")
            .append(feature.optString("feature"))
            .append(" · epoch ")
            .append(feature.optLong("generation"));
        String owner = feature.optString("component");
        description
            .append("\nSelected: ")
            .append(owner.isEmpty() ? "Host baseline" : owner.split("/", 2)[0]);
        description
            .append("\nEffective: ")
            .append(feature.optBoolean("available") ? "Selected app" : "Host fallback");
        description.append("\nConfig: ").append(feature.optJSONObject("configuration"));
        for (int n = 0; n < contenders.length(); n++) {
          JSONObject candidate = contenders.optJSONObject(n);
          if (candidate == null) continue;
          description
              .append("\n  ")
              .append(n + 1)
              .append(". ")
              .append(candidate.optString("component").split("/", 2)[0]);
          description
              .append(candidate.optBoolean("enabled") ? " · enabled" : " · disabled")
              .append(candidate.optBoolean("granted") ? " · allowed" : " · denied")
              .append(candidate.optBoolean("connected") ? " · connected" : " · offline");
        }
        description.append("\n");
      }
    updateText(status, description.toString());
    if (inspector != null) updateText(inspector, description.toString());
    updateText(
        events,
        DemoState.events.isEmpty()
            ? "No events yet."
            : android.text.TextUtils.join("\n", DemoState.events));
  }

  private static void updateText(TextView view, String text) {
    if (!text.contentEquals(view.getText())) view.setText(text);
  }

  private void inspect() {
    ScrollView scroll = new ScrollView(this);
    inspector = new TextView(this);
    inspector.setTextSize(14);
    inspector.setPadding(dp(16), dp(12), dp(16), dp(12));
    scroll.addView(inspector);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle(BuildConfig.DEMO_NAME + " · host priorities")
            .setView(scroll)
            .setPositiveButton("Close", null)
            .create();
    dialog.setOnDismissListener(ignored -> inspector = null);
    refreshStatus();
    dialog.show();
  }

  private void openHost() {
    List<ResolveInfo> hosts = new ArrayList<>();
    for (ResolveInfo result :
        getPackageManager().queryIntentActivities(new Intent("com.faceclaw.action.MANAGE_APPS"), 0))
      if (result.activityInfo.exported
          && result.activityInfo.enabled
          && result.activityInfo.applicationInfo.enabled
          && (result.activityInfo.permission == null || result.activityInfo.permission.isEmpty()))
        hosts.add(result);
    if (hosts.isEmpty()) {
      new AlertDialog.Builder(this)
          .setMessage("Install and open the Faceclaw host first.")
          .setPositiveButton("OK", null)
          .show();
      return;
    }
    String[] names = new String[hosts.size()];
    for (int i = 0; i < names.length; i++)
      names[i] = hosts.get(i).loadLabel(getPackageManager()).toString();
    java.util.function.IntConsumer launch =
        index -> {
          ResolveInfo host = hosts.get(index);
          startActivity(
              new Intent("com.faceclaw.action.MANAGE_APPS")
                  .setComponent(
                      new ComponentName(host.activityInfo.packageName, host.activityInfo.name))
                  .putExtra("appPackage", getPackageName()));
        };
    if (hosts.size() == 1) launch.accept(0);
    else
      new AlertDialog.Builder(this)
          .setTitle("Choose Faceclaw host")
          .setItems(names, (dialog, index) -> launch.accept(index))
          .show();
  }
}
