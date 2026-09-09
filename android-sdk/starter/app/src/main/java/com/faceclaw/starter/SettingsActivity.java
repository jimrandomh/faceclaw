package com.faceclaw.starter;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

/** App-owned phone settings. Host approval and capability grants stay host-owned. */
public final class SettingsActivity extends Activity {
    private static final String PREFS = "starter-settings";
    private ImageView preview;
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(16), dp(20), dp(16), dp(16));

        TextView heading = new TextView(this);
        heading.setText(getApplicationInfo().loadLabel(getPackageManager()));
        heading.setTextSize(22);
        layout.addView(heading);

        status = new TextView(this);
        status.setText("Host status: " + PreviewService.savedHostStatus(this));
        status.setPadding(0, dp(12), 0, dp(12));
        layout.addView(status);

        Switch marker = new Switch(this);
        marker.setText("Show marker in preview");
        marker.setChecked(getPreferences().getBoolean("showMarker", true));
        marker.setOnCheckedChangeListener((button, checked) -> {
            getPreferences().edit().putBoolean("showMarker", checked).apply();
            refreshPreview();
            PreviewService.refreshFromSettings();
        });
        layout.addView(marker);

        preview = new ImageView(this);
        preview.setContentDescription("Local bitmap preview");
        preview.setAdjustViewBounds(true);
        layout.addView(preview, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(180)));
        refreshPreview();

        Button hostSettings = new Button(this);
        hostSettings.setText("Open Faceclaw host settings");
        hostSettings.setOnClickListener(view -> openHostSettings());
        layout.addView(hostSettings);

        TextView note = new TextView(this);
        note.setText("Show marker changes this app's phone preview and glasses view. "
                + "Use host settings to approve connections and manage access.");
        note.setPadding(0, dp(12), 0, 0);
        layout.addView(note);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(layout);
        // Android 35 draws edge to edge. Keep controls outside system bars on
        // every supported API, including devices with display cutouts.
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        setContentView(scroll);
        scroll.requestApplyInsets();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    @Override protected void onResume() {
        super.onResume();
        refreshPreview();
        status.setText("Host status: " + PreviewService.savedHostStatus(this));
    }

    private android.content.SharedPreferences getPreferences() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void refreshPreview() {
        if (preview == null) return;
        Bitmap bitmap = Bitmap.createBitmap(576, 260, Bitmap.Config.ARGB_8888);
        PreviewDrawing.draw(new Canvas(bitmap), 576, 260, 0, getPreferences().getBoolean("showMarker", true));
        preview.setImageBitmap(bitmap);
    }

    private void openHostSettings() {
        Intent query = new Intent("com.faceclaw.action.MANAGE_APPS");
        java.util.List<android.content.pm.ResolveInfo> hosts = new java.util.ArrayList<>();
        for (android.content.pm.ResolveInfo match : getPackageManager().queryIntentActivities(query, 0)) {
            android.content.pm.ActivityInfo activity = match.activityInfo;
            if (activity != null && activity.exported && activity.enabled && activity.applicationInfo.enabled
                    && (activity.permission == null || activity.permission.isEmpty())) hosts.add(match);
        }
        if (hosts.isEmpty()) {
            android.widget.Toast.makeText(this, "Install a Faceclaw host, then return here.", android.widget.Toast.LENGTH_LONG).show();
            return;
        }
        String[] labels = new String[hosts.size()];
        for (int i = 0; i < hosts.size(); i++) labels[i] = hosts.get(i).loadLabel(getPackageManager()) + " (" + hosts.get(i).activityInfo.packageName + ")";
        new android.app.AlertDialog.Builder(this).setTitle("Choose a host to configure")
                .setItems(labels, (dialog, index) -> {
                    android.content.pm.ActivityInfo host = hosts.get(index).activityInfo;
                    Intent intent = new Intent("com.faceclaw.action.MANAGE_APPS")
                            .setComponent(new android.content.ComponentName(host.packageName, host.name));
                    try { startActivity(intent); }
                    catch (android.content.ActivityNotFoundException | SecurityException unavailable) {
                        android.widget.Toast.makeText(this, "Host settings are unavailable. Try again.", android.widget.Toast.LENGTH_LONG).show();
                    }
                }).setNegativeButton("Cancel", null).show();
    }
}
