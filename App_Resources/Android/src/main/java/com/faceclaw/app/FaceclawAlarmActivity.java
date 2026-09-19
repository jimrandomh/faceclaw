package com.faceclaw.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.DateFormat;
import java.util.Date;
import java.util.List;

/**
 * The phone's ringing screen: shown over the lock screen by the alarm
 * notification's full-screen intent (or by tapping the notification). Pure
 * Java, so it works with the JavaScript side asleep or gone. Snooze and
 * Dismiss go to the service, which journals them for the engine.
 */
public class FaceclawAlarmActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView titleView;
    private TextView textView;
    private TextView timeView;
    private Button snoozeButton;
    private long itemId;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            List<FaceclawAlarmService.Ringing> items = FaceclawAlarmService.snapshot();
            if (items.isEmpty()) {
                finish();
                return;
            }
            FaceclawAlarmService.Ringing shown = null;
            for (FaceclawAlarmService.Ringing item : items) {
                if (item.id == itemId) {
                    shown = item;
                }
            }
            if (shown == null) {
                shown = items.get(0);
                itemId = shown.id;
            }
            render(shown, items.size());
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockScreen();
        itemId = getIntent() == null ? 0 : getIntent().getLongExtra(FaceclawAlarms.EXTRA_ID, 0);
        setContentView(buildLayout());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        itemId = intent == null ? 0 : intent.getLongExtra(FaceclawAlarms.EXTRA_ID, 0);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(poll);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(poll);
        super.onPause();
    }

    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (keyguard != null) {
                keyguard.requestDismissKeyguard(this, null);
            }
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.BLACK);
        int pad = dp(32);
        root.setPadding(pad, pad, pad, pad);

        timeView = new TextView(this);
        timeView.setTextColor(Color.WHITE);
        timeView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 64);
        timeView.setTypeface(Typeface.DEFAULT_BOLD);
        timeView.setGravity(Gravity.CENTER);
        root.addView(timeView, wrap());

        titleView = new TextView(this);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        titleView.setGravity(Gravity.CENTER);
        titleView.setPadding(0, dp(16), 0, 0);
        root.addView(titleView, wrap());

        textView = new TextView(this);
        textView.setTextColor(Color.LTGRAY);
        textView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        textView.setGravity(Gravity.CENTER);
        textView.setPadding(0, dp(8), 0, dp(40));
        root.addView(textView, wrap());

        snoozeButton = new Button(this);
        snoozeButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        snoozeButton.setOnClickListener(view -> act(FaceclawAlarmService.ACTION_SNOOZE));
        root.addView(snoozeButton, button());

        Button dismissButton = new Button(this);
        dismissButton.setText("Dismiss");
        dismissButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        dismissButton.setOnClickListener(view -> act(FaceclawAlarmService.ACTION_DISMISS));
        root.addView(dismissButton, button());
        return root;
    }

    private void render(FaceclawAlarmService.Ringing item, int count) {
        timeView.setText(DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date()));
        titleView.setText(count > 1 ? item.title + " (+" + (count - 1) + " more)" : item.title);
        String status = item.silenced ? "Not answered" : item.escalated ? "" : "Ringing on the glasses";
        textView.setText(item.text.isEmpty() ? status : status.isEmpty() ? item.text : item.text + "\n" + status);
        snoozeButton.setText(FaceclawAlarms.KIND_TIMER.equals(item.kind)
                ? "+" + item.snoozeMinutes + " min"
                : "Snooze " + item.snoozeMinutes + " min");
    }

    /** Apply the action to every ringing item (one tap silences the phone). */
    private void act(String action) {
        for (FaceclawAlarmService.Ringing item : FaceclawAlarmService.snapshot()) {
            Intent intent = new Intent(this, FaceclawAlarmService.class)
                    .setAction(action)
                    .putExtra(FaceclawAlarms.EXTRA_ID, item.id);
            startService(intent);
        }
        finish();
    }

    private LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams button() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(64));
        params.topMargin = dp(12);
        return params;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}
