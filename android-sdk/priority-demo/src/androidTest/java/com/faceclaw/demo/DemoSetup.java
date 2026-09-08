package com.faceclaw.demo;

import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;
import com.faceclaw.sdk.ApprovalStore;
import com.faceclaw.sdk.PackageIdentity;

/** Separate test APK only. There is no setup receiver/service in the demo application. */
public final class DemoSetup extends Instrumentation {
  private Bundle arguments;

  @Override
  public void onCreate(Bundle values) {
    super.onCreate(values);
    arguments = values;
    start();
  }

  @Override
  public void onStart() {
    Bundle result = new Bundle();
    try {
      Context context = getTargetContext();
      String host = "com.faceclaw.sdk.hosttest";
      String identity = PackageIdentity.forPackage(context, host),
          own = PackageIdentity.forPackage(context, context.getPackageName());
      if (!identity.split(":", 3)[2].equals(own.split(":", 3)[2]))
        throw new SecurityException("Test host must share the debug signer");
      // Shell-installed instrumentation supplies synthetic consent only to the disposable test
      // host.
      ApprovalStore.open(context, "faceclaw-host").edit().putString("identity", identity).commit();
      String mode = arguments.getString("mode", "normal");
      if (!java.util.Arrays.asList(DemoSettings.MODES).contains(mode))
        throw new IllegalArgumentException("Unknown demo mode");
      DemoSettings.preferences(context)
          .edit()
          .clear()
          .putString("mode", mode)
          .putBoolean("ui.launcher", true)
          .putBoolean("ui.app-menu", true)
          .putBoolean("ui.notifications", true)
          .putBoolean(
              "requiresLauncher", Boolean.parseBoolean(arguments.getString("dependency", "false")))
          .putBoolean("enabled", Boolean.parseBoolean(arguments.getString("enabled", "true")))
          .putBoolean("withdraw", Boolean.parseBoolean(arguments.getString("withdraw", "false")))
          .commit();
      java.util.Map<String, ?> before =
          new java.util.HashMap<>(DemoSettings.preferences(context).getAll());
      android.app.Activity activity =
          startActivitySync(
              new android.content.Intent(context, SettingsActivity.class)
                  .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                  .putExtra("enabled", false)
                  .putExtra("mode", "silent")
                  .putExtra("approve", true));
      waitForIdleSync();
      runOnMainSync(activity::finish);
      if (!before.equals(DemoSettings.preferences(context).getAll()))
        throw new AssertionError("Public settings Intent changed app configuration");
      result.putString(
          "stream",
          "Prepared " + context.getPackageName() + " for synthetic host; mode=" + mode + "\n");
      finish(-1, result);
    } catch (Exception failure) {
      result.putString("stream", "FAIL " + failure + "\n");
      finish(0, result);
    }
  }
}
