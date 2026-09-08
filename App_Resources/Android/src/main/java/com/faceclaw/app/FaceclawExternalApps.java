package com.faceclaw.app;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.graphics.Color;
import android.os.*;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.*;
import com.faceclaw.sdk.*;
import org.json.*;
import java.nio.ByteBuffer;
import java.util.*;

/** Host-side policy owner. Everything from an external UID is untrusted. */
public final class FaceclawExternalApps {
 private static FaceclawExternalApps instance;
 public static synchronized FaceclawExternalApps get(Context c) { if(instance==null) instance=new FaceclawExternalApps(c.getApplicationContext()); return instance; }
 private final Context context; private final Handler main=new Handler(Looper.getMainLooper());
 private final Map<String,Connection> connections=new java.util.concurrent.ConcurrentHashMap<>();
 private FaceclawExternalAppListener listener;
 private final SharedPreferences prefs;
 private final FaceclawExtensions extensions;
 private final Map<String,Long> publishedFeatureGenerations=new HashMap<>();
 private String publishedExtensionSnapshot="";
 private JSONObject sharedStyle=new JSONObject();
 private static final String[] APPROVAL_CAPABILITIES={"notifications","dictation","previews","suppress"};
 private FaceclawExternalApps(Context c) {
  context=c; prefs=ApprovalStore.open(c,"faceclaw-external-apps");
  extensions=new FaceclawExtensions(prefs,new FaceclawExtensions.Owners() {
   public Map<String,String> approved() { Map<String,String> owners=new TreeMap<>(); for(ResolveInfo r:discover()) if(FaceclawExternalApps.this.approved(r.serviceInfo)) owners.put(key(r.serviceInfo),prefs.getString(key(r.serviceInfo)+":pin","")); return owners; }
   public boolean connected(String component) { Connection current=connections.get(component); return current!=null&&current.ready; }
  });
  IntentFilter filter=new IntentFilter(); filter.addAction(Intent.ACTION_PACKAGE_ADDED); filter.addAction(Intent.ACTION_PACKAGE_REMOVED); filter.addAction(Intent.ACTION_PACKAGE_REPLACED); filter.addAction(Intent.ACTION_PACKAGE_CHANGED); filter.addDataScheme("package");
  c.registerReceiver(new BroadcastReceiver() { public void onReceive(Context ignored,Intent intent) {
   if(Intent.ACTION_PACKAGE_REMOVED.equals(intent.getAction()) && !intent.getBooleanExtra(Intent.EXTRA_REPLACING,false) && intent.getData()!=null) {
    String pkg=intent.getData().getSchemeSpecificPart(); SharedPreferences.Editor edit=prefs.edit();
    for(String key:prefs.getAll().keySet()) if(key.startsWith(pkg+"/")) edit.remove(key); edit.apply();
   }
   refresh();
  } },filter);
 }
 public void setListener(FaceclawExternalAppListener value) { listener=value; refresh(); }
 private List<ResolveInfo> discover() { return context.getPackageManager().queryIntentServices(new Intent(Protocol.ACTION),PackageManager.GET_META_DATA); }
 private String key(ServiceInfo s) { return new ComponentName(s.packageName,s.name).flattenToString(); }
 private boolean validService(ServiceInfo s) { return key(s).length()<=512 && s.exported && s.enabled && s.applicationInfo.enabled && s.metaData!=null && s.metaData.getInt("com.faceclaw.PROTOCOL_MAJOR",0)==Protocol.VERSION; }
 private boolean approved(ServiceInfo s) {
  try { return validService(s) && PackageIdentity.forPackage(context,s.packageName).equals(prefs.getString(key(s)+":pin","")) && PackageIdentity.forUid(context,s.applicationInfo.uid).equals(prefs.getString(key(s)+":pin","")); } catch(Exception e) { return false; }
 }
 public String installedJson() {
  JSONArray result=new JSONArray();
  for(ResolveInfo r:discover()) if(approved(r.serviceInfo)) {
   Connection c=connections.get(key(r.serviceInfo));
   result.put(Protocol.object("component",key(r.serviceInfo),"name",r.loadLabel(context.getPackageManager()).toString(),"connected",c!=null&&c.ready));
  }
  return result.toString();
 }
 public void refresh() {
  Set<String> present=new HashSet<>();
  for(ResolveInfo r:discover()) if(approved(r.serviceInfo)) { String k=key(r.serviceInfo); present.add(k); if(!connections.containsKey(k)&&connections.size()<8) bind(r.serviceInfo); }
  for(String k:new ArrayList<>(connections.keySet())) if(!present.contains(k)) disconnect(k,false);
  emit("","changed",new JSONObject()); extensionsChanged();
 }
 private void bind(ServiceInfo s) {
  Connection c=new Connection(s); connections.put(c.component,c);
  try { if(!context.bindService(new Intent(Protocol.ACTION).setComponent(new ComponentName(s.packageName,s.name)),c,Context.BIND_AUTO_CREATE)) disconnect(c.component,false); }
  catch(Exception e) { disconnect(c.component,false); }
 }
 private void emit(String component,String type,JSONObject data) { if(listener!=null) listener.onEvent(component,type,data.toString()); }
 public boolean isConnected(String component) { Connection c=connections.get(component); return c!=null&&c.ready&&approved(c.service); }
 public boolean allows(String component,String capability) { return Arrays.asList(APPROVAL_CAPABILITIES).contains(capability)&&isConnected(component)&&prefs.getBoolean(component+":"+capability,"previews".equals(capability)); }
 public boolean replyToNotification(String component,String json) {
  if(json==null||json.length()>Protocol.MAX_JSON||!allows(component,"notifications")||!allows(component,"dictation")) return false;
  Connection c=connections.get(component);
  try {
   JSONObject data=new JSONObject(json);
   if(!Boolean.TRUE.equals(data.opt("confirmed"))||!(data.opt("text") instanceof String)||data.getString("text").trim().isEmpty()||data.getString("text").length()>8000) return false;
   for(String field:new String[]{"id","target","replyToken"}) if(!(data.opt(field) instanceof String)||data.getString(field).isEmpty()||data.getString(field).length()>(field.equals("target")?512:128)) return false;
   c.remote.send(Protocol.message(Protocol.EVENT,c.session,"notification-reply",data)); return true;
  } catch(Exception ignored) { return false; }
 }
 public void send(String component,String type,String json) {
  if(type.equals("notification-reply")) { replyToNotification(component,json); return; }
  Connection c=connections.get(component); if(c==null||!c.ready||!approved(c.service)) return;
  try {
   JSONObject data=new JSONObject(json);
   if(type.equals("open")||type.equals("resize")) {
    c.width=data.getInt("width"); c.height=data.getInt("height"); Protocol.frameSize(c.width,c.height); data.put("generation",++c.generation); c.open=true;
    c.frames.clear();
   }
   if(type.equals("close")) { c.open=false; c.visible=false; c.generation++; c.frames.clear(); }
   if(type.equals("visibility")) { c.visible=data.optBoolean("visible"); c.screenOn=data.optBoolean("screenOn"); if(!c.visible||!c.screenOn)c.frames.clear(); }
   c.remote.send(Protocol.message(Protocol.EVENT,c.session,type,data));
  } catch(Exception e) { disconnect(component,true); }
 }
 private void publishCapabilities(String component) {
  send(component,"capabilities",Protocol.object("notifications",allows(component,"notifications"),"dictation",allows(component,"dictation"),"previews",allows(component,"previews"),"maxWidth",Protocol.MAX_WIDTH,"maxHeight",Protocol.MAX_HEIGHT,"maxText",8000,"maxNotificationText",4096,"notificationReplies",true,"searchDictation",true,"extensions",ExtensionContract.VERSION,"windowMenus",true).toString());
 }
 private void disconnect(String component,boolean retry) {
  Connection c=connections.remove(component); if(c==null) return;
  c.ready=false; c.generation++; c.frames.clear(); for(Surface surface:c.surfaces.values())surface.frames.clear();
  try { if(c.remote!=null) c.remote.send(Protocol.message(Protocol.EVENT,c.session,"revoke",null)); } catch(Exception ignored) {}
  try { context.unbindService(c); } catch(Exception ignored) {}
  emit(component,"disconnected",new JSONObject()); extensionsChanged();
  if(retry && approved(c.service)) main.postDelayed(()->{ if(!connections.containsKey(component)&&approved(c.service)) bind(c.service); },5000);
 }
 /** At most one private snapshot waits for the 16ms boundary; the final frame is never dropped. */
 private final class FrameDelivery {
  Runnable pending; boolean scheduled; long lastFrame;
  final Runnable flush=()->{
   scheduled=false; Runnable delivery=pending; pending=null;
   if(delivery!=null) { lastFrame=SystemClock.elapsedRealtime(); delivery.run(); }
  };
  void offer(Runnable delivery,long now) {
   pending=delivery;
   if(now-lastFrame>=16) { main.removeCallbacks(flush); flush.run(); }
   else if(!scheduled) { scheduled=true; main.postDelayed(flush,16-(now-lastFrame)); }
  }
  void clear() { pending=null; scheduled=false; lastFrame=0; main.removeCallbacks(flush); }
 }
 private final class Connection implements ServiceConnection {
  final ServiceInfo service; final String component,session=UUID.randomUUID().toString(); final Messenger inbox;
  java.lang.ref.WeakReference<Activity> selectionActivity; long selectionUntil;
  final Map<String,Surface> surfaces=new HashMap<>(); final Map<String,String> extensionRequests=new HashMap<>(); final Set<String> actionIds=new HashSet<>();
  final FrameDelivery frames=new FrameDelivery();
  Messenger remote; PendingIntent consent; boolean ready,open,visible,screenOn=true; int width,height; long generation,sequence,rateStart,lastOpenRequest; int rate; String lastExtensionSnapshot="";
  Connection(ServiceInfo service) { this.service=service; component=key(service); inbox=new Messenger(new Handler(Looper.getMainLooper(),m->{ receive(m); return true; })); }
  public void onServiceConnected(ComponentName name,IBinder binder) {
   if(connections.get(component)!=this || !approved(service)) return;
   remote=new Messenger(binder);
   try { Message m=Protocol.message(Protocol.HELLO,session,"hello",Protocol.object("version",Protocol.VERSION)); m.replyTo=inbox; remote.send(m); }
   catch(Exception e) { disconnect(component,true); }
  }
  public void onServiceDisconnected(ComponentName name) { disconnect(component,true); }
  public void onBindingDied(ComponentName name) { disconnect(component,true); }
  public void onNullBinding(ComponentName name) { disconnect(component,false); }
  void receive(Message m) {
   try {
    if(connections.get(component)!=this || m.sendingUid!=service.applicationInfo.uid || !approved(service) || !PackageIdentity.forUid(context,m.sendingUid).equals(prefs.getString(component+":pin",""))) return;
    Bundle b=m.getData(); if(!session.equals(b.getString("session"))) return;
    long now=SystemClock.elapsedRealtime(); if(now-rateStart>1000) { rateStart=now; rate=0; }
    if(++rate>240) { disconnect(component,false); return; }
    if(m.what==Protocol.CONSENT) {
     PendingIntent pi=b.getParcelable("consent");
     if(pi!=null&&pi.getCreatorUid()==m.sendingUid&&service.packageName.equals(pi.getCreatorPackage())&&(Build.VERSION.SDK_INT<31||pi.isActivity())) {
      consent=pi; emit(component,"consent",new JSONObject()); launchRequestedConsent(this,pi);
     } return;
    }
    if(m.what==Protocol.READY) {
     if(Protocol.json(b).optInt("version")!=Protocol.VERSION) return;
     ready=true; consent=null; selectionActivity=null; publishCapabilities(component); send(component,"shared-style",sharedStyle.toString()); emit(component,"connected",new JSONObject()); extensionsChanged(); return;
    }
    if(!ready) return;
    if(m.what==Protocol.EXTENSION_FRAME) { receiveExtensionFrame(this,m,now); return; }
    if(m.what==Protocol.FRAME) {
     long seq=b.getLong("sequence");
     try {
      int w=b.getInt("width"),h=b.getInt("height"); int size=Protocol.frameSize(w,h);
      if(!open||!visible||!screenOn||w!=width||h!=height||b.getLong("generation")!=generation||seq<=sequence) return;
      byte[] copy;
      if(Build.VERSION.SDK_INT>=27 && b.containsKey("memory")) {
       SharedMemory memory=b.getParcelable("memory"); if(memory==null) return;
       try { if(memory.getSize()!=size) return; ByteBuffer mapping=memory.mapReadOnly(); try { copy=new byte[size]; mapping.get(copy); } finally { SharedMemory.unmap(mapping); } } finally { memory.close(); }
      } else { byte[] bytes=b.getByteArray("pixels"); if(bytes==null||bytes.length!=size) return; copy=bytes.clone(); }
      sequence=seq; final long frameGeneration=generation;
      // ACK permits another frame only after its memory has become a private snapshot.
      frames.offer(()->{
       if(connections.get(component)!=this||!ready||!approved(service)||!open||!visible||!screenOn||generation!=frameGeneration||width!=w||height!=h)return;
       try { if(listener!=null)listener.onFrame(component,w,h,ByteBuffer.wrap(copy)); }
       catch(Exception ignored) { disconnect(component,false); }
      },now);
     } finally {
      // Close descriptors even on early rejection before mapping.
      if(Build.VERSION.SDK_INT>=27 && b.containsKey("memory")) { SharedMemory mem=b.getParcelable("memory"); if(mem!=null) mem.close(); }
      Message ack=Protocol.message(Protocol.ACK,session,"ack",null); ack.getData().putLong("sequence",seq); remote.send(ack);
     }
     return;
    }
    if(m.what!=Protocol.EVENT) return;
    String type=b.getString("type",""); JSONObject data=Protocol.json(b);
    if(type.equals("host-switched")) { revokeApproval(component); return; }
    if(type.equals("disconnected")) { disconnect(component,false); return; }
    if(type.equals("publish-extensions")) {
     long before=extensions.generation(); if(extensions.publish(component,data.getJSONArray("declarations"))&&before!=extensions.generation()) extensionsChanged(); return;
    }
    if(type.equals("extension-result")||type.equals("extension-progress")||type.equals("extension-action")) { receiveExtensionControl(this,type,data); return; }
    if(type.equals("window-menu-state")) { if(open&&data.opt("available") instanceof Boolean) emit(component,type,Protocol.object("available",data.getBoolean("available"))); return; }
    if(type.equals("window-protection")) { if(open&&data.opt("protected") instanceof Boolean) emit(component,type,Protocol.object("protected",data.getBoolean("protected"))); return; }
    if(type.equals("own-notifications")||type.equals("own-notification-action")) {
     if(isExtensionGranted(component,"notification-content")&&open&&visible&&screenOn) emit(component,type,data); return;
    }
    if(type.equals("request-open-window")) {
     Object target=data.opt("target"); if(!(target instanceof String)||((String)target).length()>512||now-lastOpenRequest<2000) return;
     lastOpenRequest=now; emit(component,type,Protocol.object("target",target)); return;
    }
    if(type.equals("sleep")) { if(open&&visible&&screenOn) emit(component,type,new JSONObject()); return; }
    if(type.equals("request-system-menu")) { if(open&&visible&&screenOn) emit(component,type,new JSONObject()); return; }
    if(type.equals("notification")||type.equals("remove-notification")||type.equals("notification-reply-result")) { if(!allows(component,"notifications")) return; }
    else if(type.equals("dictation")||type.equals("cancel-dictation")||type.equals("search-dictation")||type.equals("cancel-search-dictation")||type.equals("capture-dictation")||type.equals("finish-capture-dictation")||type.equals("cancel-capture-dictation")||type.equals("host-refinement")||type.equals("cancel-host-refinement")) { if(!allows(component,"dictation")||!open||!visible||!screenOn) {
      if(type.equals("host-refinement")||type.equals("capture-dictation")) remote.send(Protocol.message(Protocol.EVENT,session,type.equals("host-refinement")?"host-refinement-rejected":"capture-dictation-closed",Protocol.object("requestId",data.optString("requestId","").substring(0,Math.min(128,data.optString("requestId","").length())),"reason","Permission or visible window required")));
      if(type.equals("dictation")||type.equals("search-dictation")) remote.send(Protocol.message(Protocol.EVENT,session,type.equals("search-dictation")?"search-dictation-rejected":"dictation-rejected",Protocol.object("requestId",data.optString("requestId","").substring(0,Math.min(128,data.optString("requestId","").length())),"reason","Dictation permission or visible window required")));
      return;
     } }
    else return;
    emit(component,type,data);
   } catch(Exception ignored) { disconnect(component,false); }
  }
 }
 public boolean isSourceSuppressed(String packageName) {
  if(packageName==null || !packageName.matches("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+")) return false;
  for(Connection c:connections.values()) if(c.ready && allows(c.component,"suppress") && c.service.metaData!=null && packageName.equals(c.service.metaData.getString("com.faceclaw.SUPPRESS_PACKAGE",""))) return true;
  return false;
 }
 public String suppressedPackagesJson() {
  JSONArray values=new JSONArray();
  for(Connection c:connections.values()) if(c.ready && allows(c.component,"suppress") && c.service.metaData!=null) {
   String source=c.service.metaData.getString("com.faceclaw.SUPPRESS_PACKAGE","");
   if(source.matches("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+")) values.put(source);
  }
  return values.toString();
 }
 /** Local settings catalog. No grants or app code are activated by enumeration. */
 public String androidAppsJson() {
  JSONArray result=new JSONArray(); PackageManager pm=context.getPackageManager();
  try {
   Map<String,ApplicationInfo> compatible=new HashMap<>();
   for(ResolveInfo resolved:discover()) {
    ServiceInfo service=resolved.serviceInfo;
    if(service!=null&&validService(service)) compatible.put(service.packageName,service.applicationInfo);
   }
   List<ApplicationInfo> apps=new ArrayList<>(compatible.values());
   apps.sort((a,b)->pm.getApplicationLabel(a).toString().compareToIgnoreCase(pm.getApplicationLabel(b).toString()));
   for(ApplicationInfo app:apps) {
    if(result.length()>=512) break;
    result.put(Protocol.object("packageName",app.packageName,"name",pm.getApplicationLabel(app).toString()));
   }
  } catch(Exception ignored) {}
  return result.toString();
 }
 /** Explicit local settings navigation only; package names never confer host authority. */
 public boolean openAndroidAppSettings(Activity activity,String appPackage) {
  if(activity==null||appPackage==null||appPackage.length()>255||!appPackage.matches("[a-zA-Z0-9_]+(?:\\.[a-zA-Z0-9_]+)+")) return false;
  try {
   context.getPackageManager().getApplicationInfo(appPackage,0);
   for(ResolveInfo app:discover()) if(appPackage.equals(app.serviceInfo.packageName)) {
    ServiceInfo current=context.getPackageManager().getServiceInfo(new ComponentName(appPackage,app.serviceInfo.name),PackageManager.GET_META_DATA);
    Intent settings=validService(current)?AppSettingsIntent.resolve(context,current):null;
    if(settings!=null) { activity.startActivity(settings); return true; }
   }
   activity.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,android.net.Uri.fromParts("package",appPackage,null)));
   return true;
  } catch(PackageManager.NameNotFoundException|ActivityNotFoundException|SecurityException ignored) { return false; }
 }
 /** Reordering existing declarations never grants a feature. Local host UI only. */
 public boolean prioritizeExtension(String feature,String component) {
  if(!ExtensionContract.known(feature)||!extensions.orderedComponents(feature).contains(component))return false;
  if(!extensions.prioritize(feature,component))return false; extensionsChanged(); return true;
 }
 public void showBehaviorSettings(Activity activity) {
  if(activity==null)return;
  JSONArray features=extensions.snapshot().optJSONArray("features"); ArrayList<String> ids=new ArrayList<>(),labels=new ArrayList<>();
  if(features!=null)for(int i=0;i<features.length();i++) {
   JSONObject feature=features.optJSONObject(i); if(feature==null)continue;
   String id=feature.optString("feature"); JSONArray contenders=feature.optJSONArray("contenders");
   if(contenders==null||contenders.length()==0)continue;
   ids.add(id);String owner=feature.optBoolean("available")?appLabel(feature.optString("component")):"Faceclaw default";
   labels.add(extensionLabel(id)+" — "+owner);
  }
  new AlertDialog.Builder(activity).setTitle("System behaviors").setItems(labels.toArray(new String[0]),(d,index)->showExtensionOrder(activity,ids.get(index))).setNegativeButton("Close",null).show();
 }
 private String appLabel(String component) {
  ComponentName name=ComponentName.unflattenFromString(component); if(name==null)return component;
  try {return context.getPackageManager().getApplicationLabel(context.getPackageManager().getApplicationInfo(name.getPackageName(),0)).toString();}catch(Exception ignored){return name.getPackageName();}
 }
 public void showManager(Activity activity) {
  if(activity==null) return; refresh(); List<ResolveInfo> apps=discover();
  String[] labels=new String[apps.size()]; for(int i=0;i<apps.size();i++) { ResolveInfo r=apps.get(i); labels[i]=r.loadLabel(context.getPackageManager())+(approved(r.serviceInfo)?" (approved)":""); }
  new AlertDialog.Builder(activity).setTitle("Installed Faceclaw apps").setItems(labels,(d,index)->openAppInterface(activity,apps.get(index)))
   .setNeutralButton("Permissions and priority",(d,w)->showPermissionsManager(activity)).setNegativeButton("Close",null).show();
 }
 private void showPermissionsManager(Activity activity) {
  List<ResolveInfo> apps=discover(); String[] labels=new String[apps.size()];
  for(int i=0;i<apps.size();i++) labels[i]=apps.get(i).loadLabel(context.getPackageManager()).toString();
  new AlertDialog.Builder(activity).setTitle("Faceclaw permissions and priority").setItems(labels,(d,index)->showApp(activity,apps.get(index))).setNeutralButton("System behaviors",(d,w)->showBehaviorSettings(activity)).setNegativeButton("Close",null).show();
 }
 private void openAppInterface(Activity activity,ResolveInfo app) {
  try {
   ServiceInfo current=context.getPackageManager().getServiceInfo(new ComponentName(app.serviceInfo.packageName,app.serviceInfo.name),PackageManager.GET_META_DATA);
   if(validService(current)) {
    Intent intent=AppSettingsIntent.resolve(context,current);
    if(intent!=null) { activity.startActivity(intent); return; }
   }
  } catch(PackageManager.NameNotFoundException|ActivityNotFoundException|SecurityException ignored) {}
  new AlertDialog.Builder(activity).setTitle("App settings unavailable").setMessage("This app has no available phone settings screen. You can still manage its Faceclaw permissions here.")
   .setPositiveButton("Faceclaw permissions",(d,w)->showApp(activity,app)).setNegativeButton("Close",null).show();
 }
 /** Navigation only. The package hint never supplies service metadata, identity or grants. */
 public void showAppSettings(Activity activity,String appPackage) {
  if(activity==null) return;
  // The exported settings Activity can be the first screen in a cold host process.
  // Reconnect only previously approved apps before presenting their host-selection state.
  refresh();
  if(appPackage!=null && appPackage.length()<=255 && appPackage.matches("[a-zA-Z0-9_]+(?:\\.[a-zA-Z0-9_]+)+")) {
   for(ResolveInfo app:discover()) if(appPackage.equals(app.serviceInfo.packageName)) {
    showApp(activity,app); return;
   }
  }
  showPermissionsManager(activity);
 }
 private boolean canShowConsent(Activity activity) {
  return activity!=null&&!activity.isFinishing()&&!activity.isDestroyed()&&activity.getWindow()!=null&&
   activity.getWindow().getDecorView().getWindowVisibility()==android.view.View.VISIBLE;
 }
 private void selectionUnavailable(Activity activity) {
  if(canShowConsent(activity)) new AlertDialog.Builder(activity).setMessage("Could not open the app's host selection. Keep this screen open and try again.").setPositiveButton("OK",null).show();
 }
 /** The explicit user tap gets a new handshake/session, never a cached expired consent token. */
 private void requestHostSelection(Activity activity,String component) {
  if(!canShowConsent(activity)) return;
  Connection previous=connections.get(component);
  if(previous==null||!approved(previous.service)) { selectionUnavailable(activity); return; }
  if(previous.ready) return;
  ServiceInfo service=previous.service; disconnect(component,false); bind(service);
  Connection requested=connections.get(component);
  if(requested==null) { selectionUnavailable(activity); return; }
  requested.selectionActivity=new java.lang.ref.WeakReference<>(activity);
  requested.selectionUntil=SystemClock.elapsedRealtime()+5000;
  main.postDelayed(()->{
   Activity waiting=requested.selectionActivity==null?null:requested.selectionActivity.get();
   requested.selectionActivity=null;
   if(waiting!=null&&!requested.ready) selectionUnavailable(waiting);
  },5000);
 }
 /** Android 14+ needs the visible sender to opt in for this one user-requested launch. */
 private void launchRequestedConsent(Connection connection,PendingIntent consent) {
  Activity activity=connection.selectionActivity==null?null:connection.selectionActivity.get();
  connection.selectionActivity=null;
  if(!canShowConsent(activity)||SystemClock.elapsedRealtime()>connection.selectionUntil||connections.get(connection.component)!=connection||!approved(connection.service)) return;
  ActivityOptions options=ActivityOptions.makeBasic();
  if(Build.VERSION.SDK_INT>=34) options.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
  try { consent.send(activity,0,null,null,null,null,options.toBundle()); }
  catch(PendingIntent.CanceledException|SecurityException error) { selectionUnavailable(activity); }
 }
 /** Fresh defaults are a proposal for explicit approval, never read-time grants. */
 private boolean[] approvalChoices(String component) {
  boolean existing=prefs.contains(component+":pin");
  for(String capability:APPROVAL_CAPABILITIES) existing|=prefs.contains(component+":"+capability);
  boolean[] choices=new boolean[APPROVAL_CAPABILITIES.length];
  for(int i=0;i<choices.length;i++) {
   String capability=APPROVAL_CAPABILITIES[i];
   choices[i]=prefs.getBoolean(component+":"+capability,!existing || capability.equals("previews"));
  }
  return choices;
 }
 /** Called only by the approval button; identity and all choices share one durable write. */
 private boolean approveSelection(ServiceInfo requested,String pin,boolean[] choices) {
  if(choices==null || choices.length!=APPROVAL_CAPABILITIES.length) return false;
  try {
   ServiceInfo current=context.getPackageManager().getServiceInfo(new ComponentName(requested.packageName,requested.name),PackageManager.GET_META_DATA);
   if(!validService(current) || !PackageIdentity.forPackage(context,current.packageName).equals(pin)) return false;
   String component=key(current);
   SharedPreferences.Editor edit=prefs.edit().putString(component+":pin",pin);
   if(!pin.equals(prefs.getString(component+":pin",""))) for(String saved:prefs.getAll().keySet()) if(saved.startsWith(component+":extension")) edit.remove(saved);
   for(int i=0;i<choices.length;i++) edit.putBoolean(component+":"+APPROVAL_CAPABILITIES[i],choices[i]);
   return edit.commit();
  } catch(Exception ignored) { return false; }
 }
 private void revokeApproval(String component) {
  SharedPreferences.Editor edit=prefs.edit().remove(component+":pin");
  for(String capability:APPROVAL_CAPABILITIES) edit.remove(component+":"+capability);
  for(String key:prefs.getAll().keySet()) if(key.startsWith(component+":extension")) edit.remove(key);
  edit.apply(); disconnect(component,false); extensionsChanged(); emit(component,"changed",new JSONObject());
 }
 private void showApp(Activity a,ResolveInfo resolved) {
  ServiceInfo s=resolved.serviceInfo; String k=key(s);
  if(!validService(s)) { new AlertDialog.Builder(a).setMessage("This app requires an incompatible Faceclaw protocol or its service is disabled.").setPositiveButton("OK",null).show(); return; }
  if(!approved(s)) {
   try {
    String pin=PackageIdentity.forPackage(context,s.packageName);
    boolean[] choices=approvalChoices(k);
    int padding=(int)(20*a.getResources().getDisplayMetrics().density);
    LinearLayout content=new LinearLayout(a); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(padding,padding,padding,0);
    TextView explanation=new TextView(a); explanation.setText("Allow this independently installed app to show a glasses window, receive input, and read the battery/weather displayed by the host? Checked permissions will be enabled when you approve. You can uncheck any permission now or change it later."); content.addView(explanation);
    String source=s.metaData.getString("com.faceclaw.SUPPRESS_PACKAGE","");
    String[] labels={"Notifications on glasses","Dictation and review","Message text previews","Suppress declared source on glasses"};
    for(int i=0;i<choices.length;i++) {
     final int index=i; CheckBox choice=new CheckBox(a); choice.setText(labels[i]); choice.setChecked(choices[i]); choice.setFilterTouchesWhenObscured(true);
     choice.setOnCheckedChangeListener((button,checked)->choices[index]=checked); content.addView(choice);
    }
    TextView detail=new TextView(a); detail.setText("Suppression applies only to the app's declared source while connected. Phone notifications stay unchanged."+(source.isEmpty()?"\nNo source is currently declared.":"\nDeclared source: "+source)+"\n\nSigning identity: "+pin); content.addView(detail);
    ScrollView scroll=new ScrollView(a); scroll.addView(content);
    AlertDialog consent=new AlertDialog.Builder(a).setTitle("Approve "+resolved.loadLabel(context.getPackageManager()))
     .setView(scroll).setNegativeButton("Cancel",null).setPositiveButton("Approve",(d,w)->{
      if(!approveSelection(s,pin,choices)) { new AlertDialog.Builder(a).setMessage("App identity changed or approval could not be saved. Reopen app settings and try again.").setPositiveButton("OK",null).show(); return; }
      refresh(); main.postDelayed(()->showApp(a,resolved),400);
     }).create();
    consent.show(); consent.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    consent.getButton(AlertDialog.BUTTON_POSITIVE).setFilterTouchesWhenObscured(true);
   } catch(Exception ignored) {} return;
  }
  Connection c=connections.get(k);
  ArrayList<String> options=new ArrayList<>(); options.add(c!=null&&c.ready?"Host selected":"Select this host on app");
  options.add("Notifications: "+prefs.getBoolean(k+":notifications",false)); options.add("Dictation/review: "+prefs.getBoolean(k+":dictation",false));
  options.add("Message text previews: "+prefs.getBoolean(k+":previews",true));
  options.add("Suppress declared source on glasses: "+prefs.getBoolean(k+":suppress",false));
  options.add("Configure bridge connection"); options.add("Global customizations and providers"); options.add("Revoke app approval");
  new AlertDialog.Builder(a).setTitle(resolved.loadLabel(context.getPackageManager())).setItems(options.toArray(new String[0]),(d,index)->{
   if(index==0) requestHostSelection(a,k);
   else if(index>=1&&index<=4) {
    String flag=new String[]{"","notifications","dictation","previews","suppress"}[index];
    String source=s.metaData.getString("com.faceclaw.SUPPRESS_PACKAGE","");
    if(index==4&&source.isEmpty()) return;
    boolean enabled=prefs.getBoolean(k+":"+flag,flag.equals("previews"));
    Runnable change=()->{ prefs.edit().putBoolean(k+":"+flag,!enabled).apply(); emit(k,"grants-changed",new JSONObject()); publishCapabilities(k); };
    if(!enabled) new AlertDialog.Builder(a).setMessage(index==4?"Suppress only "+source+" notifications on glasses while this app is connected? Phone notifications stay unchanged.":"Enable "+options.get(index).split(":")[0]+" for this app?").setNegativeButton("Cancel",null).setPositiveButton("Enable",(dialog,which)->change.run()).show(); else change.run();
   } else if(index==5) configure(a,k,s); else if(index==6) showExtensions(a,k); else revokeApproval(k);
  }).setNegativeButton("Close",null).show();
 }
 public boolean publishSharedStyle(String json) {
  if(json==null||json.length()>ExtensionContract.MAX_CONFIG) return false;
  try {
   JSONObject style=ExtensionContract.configuration("ui.typography",new JSONObject(json));
   if(style.toString().equals(sharedStyle.toString())) return true; sharedStyle=style;
   for(Connection c:connections.values()) if(c.ready) send(c.component,"shared-style",sharedStyle.toString()); return true;
  } catch(Exception ignored) { return false; }
 }
 public String extensionsJson() { return extensions.snapshot().toString(); }
 private void extensionsChanged() {
  extensions.changed();
  Set<String> changed=new HashSet<>();
  for(String feature:ExtensionContract.FEATURES) {
   long epoch=extensions.generation(feature);
   if(!Long.valueOf(epoch).equals(publishedFeatureGenerations.put(feature,epoch))) changed.add(feature);
  }
  for(Connection c:connections.values()) {
   c.extensionRequests.entrySet().removeIf(entry->changed.contains(entry.getValue()) || (entry.getValue().equals("transcription")&&!isExtensionGranted(c.component,"transcription")));
   for(String feature:changed) { Surface surface=c.surfaces.remove(feature); if(surface!=null)surface.frames.clear(); }
  }
  String snapshot=extensionsJson();
  for(Connection c:connections.values()) if(c.ready&&!snapshot.equals(c.lastExtensionSnapshot)) {
   c.lastExtensionSnapshot=snapshot;send(c.component,"extensions",snapshot);
   // A failed send can synchronously disconnect and publish a newer snapshot.
   if(!snapshot.equals(extensionsJson()))return;
  }
  if(snapshot.equals(publishedExtensionSnapshot))return;
  publishedExtensionSnapshot=snapshot;
  FaceclawSettings.getInstance(context).setString("apps.extensions.effective",snapshot);
  emit("","extensions-changed",extensions.snapshot());
 }
 /** Local host API. This is never exposed as an external IPC setter. */
 public boolean isExtensionGranted(String component,String feature) { return extensions.granted(component,feature)&&isConnected(component); }
 public boolean sendAppProvider(String component,String feature,String type,String json) {
  if(!feature.equals("transcription")||!isExtensionGranted(component,feature)||!Arrays.asList("request","event","cancel").contains(type)) return false;
  return sendExtensionInternal(component,feature,type,json,true);
 }
 public boolean sendExtension(String component,String feature,String type,String json) { return sendExtensionInternal(component,feature,type,json,false); }
 private boolean sendExtensionInternal(String component,String feature,String type,String json,boolean ownProvider) {
  if(!isConnected(component)||(!ownProvider&&!extensions.controls(component,feature))||json==null||json.length()>Protocol.MAX_JSON/2||!Arrays.asList("request","event","cancel","input").contains(type)) return false;
  Connection c=connections.get(component); if(c==null) return false;
  try {
   JSONObject data=new JSONObject(json); long generation=extensions.generation(feature);
   if(type.equals("request")) {
    String id=data.getString("requestId"); if(!ExtensionContract.token(id)||c.extensionRequests.size()>=32||c.extensionRequests.containsKey(id)) return false;
    c.extensionRequests.put(id,feature);
    main.postDelayed(()->{
     if(connections.get(component)==c&&generation==extensions.generation(feature)&&feature.equals(c.extensionRequests.remove(id)))
      emit(component,"extension-event",Protocol.object("feature",feature,"generation",generation,"type","timeout","requestId",id));
    },feature.equals("assistant")?600000:feature.equals("transcription")?390000:feature.equals("refinement")?120000:20000);
   }
   if(type.equals("cancel")) c.extensionRequests.remove(data.optString("requestId"));
   Message outgoing=Protocol.message(Protocol.EVENT,c.session,"extension-event",Protocol.object("feature",feature,"generation",generation,"type",type,"data",data));
   try { c.remote.send(outgoing); }
   catch(Exception uncertain) {
    String id=data.optString("requestId");
    if(feature.equals(c.extensionRequests.remove(id))) emit(component,"extension-event",Protocol.object("feature",feature,"generation",generation,"type","timeout","requestId",id));
    // IPC was attempted. A transport exception cannot safely authorize backend fallback/retry.
   }
   return true;
  } catch(Exception ignored) { return false; }
 }
 private void receiveExtensionControl(Connection c,String type,JSONObject data) throws Exception {
  String feature=data.getString("feature"); long generation=data.getLong("generation");
  boolean pending=feature.equals(c.extensionRequests.get(data.optString("requestId")));
  if(generation!=extensions.generation(feature)||(!extensions.controls(c.component,feature)&&!(pending&&feature.equals("transcription")&&isExtensionGranted(c.component,feature)))) return;
  JSONObject payload=data.getJSONObject("data"); if(payload.toString().length()>Protocol.MAX_JSON/2) return;
  if(type.equals("extension-result")||type.equals("extension-progress")) {
   String id=data.getString("requestId"); if(!feature.equals(c.extensionRequests.get(id))) return;
   if(type.equals("extension-result")) c.extensionRequests.remove(id);
   emit(c.component,"extension-event",Protocol.object("feature",feature,"generation",generation,"type",type.equals("extension-result")?"result":"progress","requestId",id,"data",payload));
  } else {
   String action=data.getString("action"), id=data.getString("actionId");
   if(!ExtensionContract.action(feature,action)||!ExtensionContract.token(id)||c.actionIds.contains(id)) return;
   // Fail closed after the session's bounded action ledger fills; never forget a consumed authority.
   if(c.actionIds.size()>=4096) return; c.actionIds.add(id);
   emit(c.component,"extension-event",Protocol.object("feature",feature,"generation",generation,"type","action","action",action,"actionId",id,"data",payload));
  }
 }
 private final class Surface {
  final FrameDelivery frames=new FrameDelivery();
  int width,height; long generation,sequence; boolean visible,screenOn;
  Surface(int width,int height,long generation) { this.width=width; this.height=height; this.generation=generation; }
 }
 private long nextSurfaceGeneration=1;
 /** Only the host's real mirror hit-test dispatches bounded pointer input to a current visible surface. */
 public boolean sendExtensionPointer(String component,String feature,int x,int y,int width,int height) {
  if(!ExtensionContract.surface(feature)||!isConnected(component)||!extensions.controls(component,feature)) return false;
  Connection c=connections.get(component); Surface surface=c==null?null:c.surfaces.get(feature);
  if(surface==null||!surface.visible||!surface.screenOn||surface.width!=width||surface.height!=height||x<0||y<0||x>=width||y>=height) return false;
  return sendExtensionInternal(component,feature,"input",Protocol.object("event","input","input",Protocol.object("type","pointer-click","x",x,"y",y)).toString(),false);
 }
 public boolean openExtensionSurface(String component,String feature,int width,int height) {
  if(!ExtensionContract.surface(feature)||!isConnected(component)||!extensions.controls(component,feature)) return false;
  try {
   Protocol.frameSize(width,height); Connection c=connections.get(component); Surface surface=new Surface(width,height,++nextSurfaceGeneration); Surface previous=c.surfaces.put(feature,surface); if(previous!=null)previous.frames.clear();
   c.remote.send(Protocol.message(Protocol.EVENT,c.session,"extension-surface",Protocol.object("feature",feature,"type","open","width",width,"height",height,"generation",surface.generation,"extensionGeneration",extensions.generation(feature),"visible",false,"screenOn",false))); return true;
  } catch(Exception ignored) { return false; }
 }
 public void setExtensionSurfaceVisibility(String component,String feature,boolean visible,boolean screenOn) {
  Connection c=connections.get(component); if(c==null||!extensions.controls(component,feature)) return;
  Surface surface=c.surfaces.get(feature); if(surface==null) return; surface.visible=visible; surface.screenOn=screenOn;
  if(!visible||!screenOn)surface.frames.clear();
  send(component,"extension-surface",Protocol.object("feature",feature,"type","visibility","generation",surface.generation,"visible",visible,"screenOn",screenOn).toString());
 }
 public void closeExtensionSurface(String component,String feature) {
  Connection c=connections.get(component); if(c==null) return; Surface surface=c.surfaces.remove(feature); if(surface==null) return;
  surface.frames.clear();
  send(component,"extension-surface",Protocol.object("feature",feature,"type","close","generation",surface.generation).toString());
 }
 private void receiveExtensionFrame(Connection c,Message message,long now) throws Exception {
  Bundle b=message.getData(); String feature=b.getString("feature",""); long sequence=b.getLong("sequence");
  try {
   Surface surface=c.surfaces.get(feature);
   if(surface==null||!extensions.controls(c.component,feature)||!surface.visible||!surface.screenOn||surface.generation!=b.getLong("generation")||sequence<=surface.sequence) return;
   int width=b.getInt("width"),height=b.getInt("height"),size=Protocol.frameSize(width,height);
   if(width!=surface.width||height!=surface.height) return;
   byte[] copy;
   if(Build.VERSION.SDK_INT>=27&&b.containsKey("memory")) {
    SharedMemory memory=b.getParcelable("memory"); if(memory==null||memory.getSize()!=size) return;
    ByteBuffer mapping=memory.mapReadOnly(); try { copy=new byte[size]; mapping.get(copy); } finally { SharedMemory.unmap(mapping); }
   } else { byte[] supplied=b.getByteArray("pixels"); if(supplied==null||supplied.length!=size) return; copy=supplied.clone(); }
   surface.sequence=sequence; final long frameGeneration=surface.generation;
   surface.frames.offer(()->{
    if(connections.get(c.component)!=c||!c.ready||!approved(c.service)||c.surfaces.get(feature)!=surface||!extensions.controls(c.component,feature)||!surface.visible||!surface.screenOn||surface.generation!=frameGeneration||surface.width!=width||surface.height!=height)return;
    try { if(listener!=null)listener.onExtensionFrame(c.component,feature,frameGeneration,width,height,ByteBuffer.wrap(copy)); }
    catch(Exception ignored) { disconnect(c.component,false); }
   },now);
  } finally {
   if(Build.VERSION.SDK_INT>=27&&b.containsKey("memory")) { SharedMemory memory=b.getParcelable("memory"); if(memory!=null) memory.close(); }
   Message ack=Protocol.message(Protocol.EXTENSION_ACK,c.session,"ack",null); ack.getData().putString("feature",feature); ack.getData().putLong("generation",b.getLong("generation")); ack.getData().putLong("sequence",sequence); c.remote.send(ack);
  }
 }
 private String extensionLabel(String feature) {
  switch(feature) {
   case "notification-content": return "Own inbox (reads other apps’ notification content; open and dismiss with user input)";
   case "ui.notifications": return "Notification presentation (reads other apps' notification content)";
   case "device-tools": return "Device tools (read and act through approved host tools)";
   case "assistant": return "Assistant (receives assistant prompts)";
   case "transcription": return "Transcription (receives microphone audio)";
   case "refinement": return "Refinement (receives dictated drafts)";
   default: return feature;
  }
 }
 private void showExtensions(Activity activity,String component) {
  ArrayList<String> features=new ArrayList<>(),labels=new ArrayList<>();
  for(String feature:ExtensionContract.FEATURES) if(extensions.declaration(component,feature)!=null) { features.add(feature); labels.add(extensionLabel(feature)+": "+(extensions.granted(component,feature)?"allowed":"not allowed")); }
  if(features.isEmpty()) { new AlertDialog.Builder(activity).setMessage("This app has not published customization features. Open its settings and connect it first.").setPositiveButton("OK",null).show(); return; }
  new AlertDialog.Builder(activity).setTitle("Global customizations").setItems(labels.toArray(new String[0]),(d,index)->{
   String feature=features.get(index); boolean granted=extensions.granted(component,feature);
   new AlertDialog.Builder(activity).setTitle(extensionLabel(feature)).setItems(new String[]{granted?"Revoke permission":"Grant permission","Set feature priority"},(dialog,choice)->{
    if(choice==1) { showExtensionOrder(activity,feature); return; }
    if(granted) { extensions.grant(component,feature,false); extensionsChanged(); return; }
    AlertDialog consent=new AlertDialog.Builder(activity).setTitle("Allow global feature?").setMessage(extensionLabel(feature)+" can affect Faceclaw outside this app. Android system settings are not granted. You can revoke this permission here.").setNegativeButton("Cancel",null).setPositiveButton("Allow",(ignored,which)->{ if(extensions.grant(component,feature,true)) extensionsChanged(); }).create();
    consent.show(); consent.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE); consent.getButton(AlertDialog.BUTTON_POSITIVE).setFilterTouchesWhenObscured(true);
   }).setNegativeButton("Close",null).show();
  }).setNegativeButton("Close",null).show();
 }
 private void showExtensionOrder(Activity activity,String feature) {
  List<String> components=extensions.orderedComponents(feature); String[] labels=new String[components.size()];
  for(int i=0;i<labels.length;i++) { ComponentName name=ComponentName.unflattenFromString(components.get(i)); String label=name==null?components.get(i):name.getPackageName(); try { label=context.getPackageManager().getApplicationLabel(context.getPackageManager().getApplicationInfo(name.getPackageName(),0)).toString(); } catch(Exception ignored) {} labels[i]=(i+1)+". "+label; }
  new AlertDialog.Builder(activity).setTitle("Priority: tap to move first").setItems(labels,(d,index)->{ if(extensions.prioritize(feature,components.get(index))) extensionsChanged(); showExtensionOrder(activity,feature); }).setNegativeButton("Done",null).show();
 }
 private void configure(Activity a,String k,ServiceInfo service) {
  if(!isConnected(k)||!"bridge".equals(service.metaData.getString("com.faceclaw.CONFIGURATION",""))) return;
  LinearLayout layout=new LinearLayout(a); layout.setOrientation(LinearLayout.VERTICAL);
  EditText endpoint=new EditText(a); endpoint.setHint("https://private-bridge.example"); endpoint.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);
  EditText code=new EditText(a); code.setHint("One-time bridge pairing code"); code.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
  layout.addView(endpoint); layout.addView(code);
  AlertDialog dialog=new AlertDialog.Builder(a).setTitle("Connect app to bridge").setView(layout).setNegativeButton("Cancel",null).setPositiveButton("Pair",(d,w)->{
   String url=endpoint.getText().toString().trim(), token=code.getText().toString().trim();
   if(url.startsWith("https://")&&url.length()<2048&&token.length()>=16&&token.length()<=512) send(k,"configure",Protocol.object("endpoint",url,"code",token).toString());
   code.setText("");
  }).create(); dialog.getWindow(); dialog.show(); dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
 }
}
