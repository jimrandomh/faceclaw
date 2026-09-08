package com.faceclaw.demo;

import android.content.Context;
import android.content.SharedPreferences;
import com.faceclaw.sdk.Protocol;
import org.json.JSONArray;
import org.json.JSONObject;

/** App-owned declarations only. Grants and priority always belong to the host. */
final class DemoSettings {
  static final String[] FEATURES = {
    "ui.typography",
    "ui.navigation",
    "ui.window-layout",
    "ui.launcher",
    "ui.app-menu",
    "ui.notifications",
    "assistant",
    "transcription",
    "refinement"
  };
  static final String[] LABELS = {
    "Typography",
    "Navigation gestures",
    "Window layout",
    "Launcher surface",
    "App menu surface",
    "Synthetic notification surface",
    "Synthetic assistant",
    "Synthetic transcription",
    "Synthetic refinement"
  };
  static final String[] MODES = {"normal", "delay", "unavailable", "silent", "late"};
  static final String[] MODE_LABELS = {
    "Immediate synthetic response",
    "Delay response 10 seconds",
    "Reject before dispatch",
    "Stay silent (host deadline)",
    "Reply after cancellation (15 seconds)"
  };

  static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences("priority-demo", 0);
  }

  static boolean enabled(SharedPreferences prefs, String feature) {
    return prefs.getBoolean(
        feature,
        feature.equals("ui.typography")
            || feature.equals("ui.navigation")
            || feature.equals("ui.window-layout")
            || feature.equals("assistant"));
  }

  static JSONArray declarations(SharedPreferences prefs) {
    JSONArray values = new JSONArray();
    if (prefs.getBoolean("withdraw", false)) return values;
    boolean master = prefs.getBoolean("enabled", true), a = BuildConfig.PROFILE_A;
    for (String feature : FEATURES) {
      JSONObject configuration;
      switch (feature) {
        case "ui.typography":
          configuration =
              Protocol.object(
                  "font",
                  a ? "Inter_18pt-Regular.ttf" : "Roboto-Regular.ttf",
                  "size",
                  a ? 18 : 14,
                  "raster",
                  a ? "crisp" : "antialiased",
                  "borderWidth",
                  a ? 3 : 1,
                  "selectionBorderWidth",
                  a ? 3 : 1,
                  "cardRadius",
                  a ? 12 : 0);
          break;
        case "ui.navigation":
          configuration =
              Protocol.object(
                  "doubleTap",
                  "back",
                  "rootBack",
                  a ? "sleep" : "switcher",
                  "tapHold",
                  a ? "switcher" : "app-menu",
                  "hold",
                  a ? "app-menu" : "system-menu",
                  "wakeFocus",
                  a ? "window" : "sidebar");
          break;
        case "ui.window-layout":
          configuration =
              Protocol.object(
                  "centered",
                  a,
                  "sidebarMode",
                  a ? "overlay" : "persistent",
                  "switcherHeight",
                  a ? "display" : "minimum",
                  "dividerWidth",
                  a ? 3 : 1,
                  "ownTopBar",
                  true,
                  "ownHeightMode",
                  a ? "medium" : "min",
                  "inputDialogs",
                  a ? "viewport" : "compact");
          break;
        case "ui.app-menu":
          configuration =
              Protocol.object(
                  "title",
                  BuildConfig.DEMO_NAME + " actions",
                  "systemTitle",
                  "System actions",
                  "displayOffFirst",
                  false,
                  "systemActionsLast",
                  true);
          break;
        case "ui.launcher":
          configuration =
              Protocol.object(
                  "label",
                  BuildConfig.DEMO_NAME + " launcher",
                  "filesDefaultView",
                  a ? "list" : "icons");
          break;
        default:
          configuration = Protocol.object("label", BuildConfig.DEMO_NAME + " synthetic " + feature);
      }
      JSONArray dependencies = new JSONArray();
      if (feature.equals("ui.typography") && prefs.getBoolean("requiresLauncher", false))
        dependencies.put("ui.launcher");
      values.put(
          Protocol.object(
              "feature",
              feature,
              "enabled",
              master && enabled(prefs, feature),
              "configuration",
              configuration,
              "requires",
              dependencies));
    }
    return values;
  }

  private DemoSettings() {}
}
