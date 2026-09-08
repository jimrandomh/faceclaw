package com.faceclaw.demo;

import android.os.SystemClock;
import java.util.ArrayDeque;
import org.json.JSONObject;

/**
 * Main-looper diagnostics. No prompts, notification contents, audio or credentials are recorded.
 */
final class DemoState {
  static boolean connected;
  static JSONObject snapshot = new JSONObject();
  static final ArrayDeque<String> events = new ArrayDeque<>();

  static void log(String event) {
    if (events.size() >= 30) events.removeLast();
    events.addFirst((SystemClock.elapsedRealtime() / 1000) + "s  " + event);
  }

  private DemoState() {}
}
