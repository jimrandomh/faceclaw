package com.faceclaw.sdk;

import android.app.*;
import android.os.Bundle;
import android.view.WindowManager;
/** Only app-created immutable PendingIntents reach this non-exported activity. */
public final class HostApprovalActivity extends Activity {
 @Override public void onCreate(Bundle state) {
  super.onCreate(state); getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
  String token=getIntent().getStringExtra("token");
  FaceclawAppService service=FaceclawAppService.active;
  String identity=service==null?null:service.pendingIdentity(token);
  if(identity==null) { finish(); return; }
  String label=PackageIdentity.packageName(identity);
  try { label=getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(label,0)).toString(); } catch(Exception ignored) {}
  new AlertDialog.Builder(this).setTitle("Use "+label+" for your glasses?")
   .setMessage("This Faceclaw app connects to your glasses. Allow it to show this app and receive your glasses input? It will become the selected host.\n\nApp: "+PackageIdentity.packageName(identity))
   .setNegativeButton("Cancel",(d,w)->finish())
   .setPositiveButton("Use this host",(d,w)->{ service.approveHost(token); finish(); })
   .setOnCancelListener(d->finish()).show();
 }
}
