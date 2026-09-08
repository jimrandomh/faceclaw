package com.faceclaw.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.*;

/** External entry point to existing approval UI; every grant still needs its own user tap. */
public final class FaceclawAppSettingsActivity extends Activity {
 @Override public void onCreate(Bundle state) {
  super.onCreate(state);
  getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
  String appPackage=null;
  try { appPackage=getIntent().getStringExtra("appPackage"); } catch(RuntimeException ignored) {}
  final String requestedPackage=appPackage;
  LinearLayout layout=new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
  int padding=(int)(24*getResources().getDisplayMetrics().density); layout.setPadding(padding,padding,padding,padding);
  TextView title=new TextView(this); title.setText("Faceclaw app permissions"); title.setTextSize(24); layout.addView(title);
  TextView explanation=new TextView(this); explanation.setText("Approve an app to show it in the glasses launcher, then select this Faceclaw app as its host. Dictation, notifications and global customizations each need your permission. Choose per-feature priority under Global customizations and providers. Return to the app to control its own settings."); explanation.setTextSize(17); explanation.setPadding(0,padding,0,padding); layout.addView(explanation);
  Button manage=new Button(this); manage.setText("Permissions and priority"); manage.setFilterTouchesWhenObscured(true); layout.addView(manage);
  manage.setOnClickListener(v->FaceclawExternalApps.get(this).showAppSettings(this,requestedPackage));
  Button done=new Button(this); done.setText("Return to app setup"); layout.addView(done); done.setOnClickListener(v->finish());
  setContentView(layout);
  layout.post(()->{ if(!isFinishing()) FaceclawExternalApps.get(this).showAppSettings(this,requestedPackage); });
 }
}
