package com.faceclaw.sdk;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;

/** Navigation only: no caller-supplied component, extras, grants, or URI permissions. */
public final class AppSettingsIntent {
 public static final String ACTION = "com.faceclaw.action.APP_SETTINGS";
 public static boolean allowedTarget(ServiceInfo service, ActivityInfo activity) {
  return service != null && service.applicationInfo != null && service.packageName != null &&
   activity != null && service.packageName.equals(activity.packageName) &&
   activity.applicationInfo != null && service.applicationInfo.uid == activity.applicationInfo.uid &&
   activity.exported && activity.enabled && activity.applicationInfo.enabled &&
   (activity.permission == null || activity.permission.isEmpty());
 }
 public static Intent resolve(Context context, ServiceInfo service) {
  if(service == null || service.packageName == null) return null;
  PackageManager pm = context.getPackageManager();
  for(String action : new String[]{ACTION, Intent.ACTION_MAIN}) {
   Intent query = new Intent(action).setPackage(service.packageName);
   if(Intent.ACTION_MAIN.equals(action)) query.addCategory(Intent.CATEGORY_LAUNCHER);
   for(ResolveInfo resolved : pm.queryIntentActivities(query, 0)) {
    ActivityInfo info = resolved.activityInfo;
    if(!allowedTarget(service, info)) continue;
    ComponentName component = new ComponentName(info.packageName, info.name);
    try {
     // Recheck the explicit target, including aliases, immediately before returning it.
     if(!allowedTarget(service, pm.getActivityInfo(component, 0))) continue;
     return new Intent(action).setComponent(component);
    } catch(PackageManager.NameNotFoundException ignored) {}
   }
  }
  return null;
 }
 private AppSettingsIntent() {}
}
