package com.faceclaw.sdk.hosttest;
import android.app.Instrumentation;
import android.os.Bundle;
import android.content.*;
import com.faceclaw.app.*;
import com.faceclaw.sdk.*;
import java.nio.ByteBuffer;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Real cross-UID IPC; only synthetic fixture packages are approved. */
public class BoundaryTest extends Instrumentation {
 private boolean demos; private String only="";
 @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); demos=Boolean.parseBoolean(arguments.getString("demos","false"));only=arguments.getString("only","");start(); }
 @Override public void onStart() {
  int passed=0,failed=0; StringBuilder output=new StringBuilder();
  for(java.lang.reflect.Method method:getClass().getMethods()) if(method.getName().startsWith("test")&&method.getName().startsWith("testDemo")==demos&&(only.isEmpty()||only.equals(method.getName()))&&(!method.getName().equals("testDemoLateReplyCannotCrossOwnerChange")||!only.isEmpty())) {
   try { setUp(); method.invoke(this); passed++; output.append("PASS ").append(method.getName()).append("\n"); }
   catch(Throwable error) { failed++; Throwable cause=error.getCause()==null?error:error.getCause(); output.append("FAIL ").append(method.getName()).append(": ").append(cause).append("\n"); }
   finally { try { tearDown(); } catch(Exception ignored) {} }
  }
  Bundle result=new Bundle(); result.putString("stream",output.toString()+measurements+"Passed: "+passed+" Failed: "+failed+"\n"); if(passed+failed==0){failed++;result.putString("stream","FAIL No matching tests\n");} result.putInt("passed",passed); result.putInt("failed",failed); finish(failed==0?-1:0,result);
 }
 private Instrumentation getInstrumentation() { return this; }
 private static void assertTrue(String message,boolean value) { if(!value) throw new AssertionError(message); }
 private static void assertFalse(boolean value) { assertTrue("Expected false",!value); }
 private static void assertEquals(Object expected,Object actual) { if(!java.util.Objects.equals(expected,actual)) throw new AssertionError("Expected "+expected+" but got "+actual); }
 static final String PKG="com.faceclaw.sdk.fixture";
 Context context; FaceclawExternalApps manager; AtomicInteger frames,notifications,replyResults,searchRequests,extensionFrames,extensionResults,extensionTimeouts,ownRequests,refineRequests,systemMenuRequests; volatile String systemMenuPayload; volatile int extensionTransparent=-1,extensionBlack=-1,latestFrame=-1,latestExtensionFrame=-1; CountDownLatch connected;
 volatile String extensionResultPayload,extensionActionPayload;
 java.util.List<Double> timings=new java.util.concurrent.CopyOnWriteArrayList<>();
 StringBuilder measurements=new StringBuilder();
 private void clearFixtureGrants() {
  android.content.SharedPreferences preferences=context.getSharedPreferences("faceclaw-external-apps",0);
  android.content.SharedPreferences.Editor edit=preferences.edit();
  for(String key:preferences.getAll().keySet()) if(key.startsWith(PKG+"/")) edit.remove(key);
  edit.commit();
 }
 private void selectFixtureHost() throws Exception {
  CountDownLatch bound=new CountDownLatch(1); java.util.concurrent.atomic.AtomicReference<android.os.IBinder> remote=new java.util.concurrent.atomic.AtomicReference<>();
  ServiceConnection connection=new ServiceConnection() {
   public void onServiceConnected(ComponentName name,android.os.IBinder binder) { remote.set(binder); bound.countDown(); }
   public void onServiceDisconnected(ComponentName name) {}
  };
  assertTrue("Fixture setup bind",context.bindService(new Intent().setComponent(new ComponentName(PKG,PKG+".FixtureSetupService")),connection,Context.BIND_AUTO_CREATE));
  try {
   assertTrue("Fixture setup readiness",bound.await(5,TimeUnit.SECONDS));
   android.os.Parcel data=android.os.Parcel.obtain(),reply=android.os.Parcel.obtain();
   try { data.writeInterfaceToken("com.faceclaw.sdk.fixture.Setup"); remote.get().transact(1,data,reply,0); reply.readException(); }
   finally { data.recycle(); reply.recycle(); }
  } finally { context.unbindService(connection); }
 }
 public void setUp() throws Exception {
  context=getInstrumentation().getTargetContext(); extensionResultPayload=null;extensionActionPayload=null; latestFrame=-1; latestExtensionFrame=-1; selectFixtureHost(); timings.clear(); frames=new AtomicInteger(); ownRequests=new AtomicInteger(); systemMenuRequests=new AtomicInteger(); systemMenuPayload=null; refineRequests=new AtomicInteger(); extensionFrames=new AtomicInteger(); extensionResults=new AtomicInteger(); extensionTimeouts=new AtomicInteger(); notifications=new AtomicInteger(); replyResults=new AtomicInteger(); searchRequests=new AtomicInteger(); connected=new CountDownLatch(1);
  getInstrumentation().runOnMainSync(()->{
   clearFixtureGrants();
   manager=FaceclawExternalApps.get(context); manager.refresh();
   manager.setListener(new FaceclawExternalAppListener() {
    public void onEvent(String component,String type,String json) { if(type.equals("extension-event")&&json.contains("\"type\":\"action\""))extensionActionPayload=json; if(type.equals("connected")) connected.countDown(); if(type.equals("extension-event")&&json.contains("\"result\"")) { extensionResultPayload=json; extensionResults.incrementAndGet(); } if(type.equals("extension-event")&&json.contains("\"timeout\"")) extensionTimeouts.incrementAndGet(); if(type.equals("notification")) notifications.incrementAndGet(); if(type.equals("notification-reply-result")) replyResults.incrementAndGet(); if(type.equals("search-dictation")) searchRequests.incrementAndGet(); if(type.equals("own-notifications")) ownRequests.incrementAndGet(); if(type.equals("request-system-menu")) { systemMenuPayload=json; systemMenuRequests.incrementAndGet(); } if(type.equals("host-refinement")) refineRequests.incrementAndGet(); }
    public void onExtensionFrame(String component,String feature,long generation,int width,int height,ByteBuffer pixels) { extensionTransparent=pixels.get(0)&255; extensionBlack=pixels.get(1)&255; latestExtensionFrame=pixels.get(pixels.limit()-1)&255; extensionFrames.incrementAndGet(); }
    public void onFrame(String component,int width,int height,ByteBuffer pixels) { if(pixels.remaining()==width*height) {
     latestFrame=pixels.get(pixels.limit()-1)&255; frames.incrementAndGet();
     long timestamp=0,multiplier=1;
     for(int i=0;i<8;i++) { timestamp+=((pixels.get(i)&255)-1)*multiplier; multiplier*=255; }
     double elapsed=(android.os.SystemClock.elapsedRealtimeNanos()-timestamp)/1000000.0;
     if(elapsed>=0&&elapsed<10000) timings.add(elapsed);
    } }
   });
  });
 }
 public void tearDown() throws Exception { if(demos)clearDemoGrants();getInstrumentation().runOnMainSync(()->{ clearFixtureGrants(); manager.refresh(); }); }
 String approve(String service) throws Exception {
  String component=PKG+"/"+PKG+"."+service, identity=PackageIdentity.forPackage(context,PKG);
  getInstrumentation().runOnMainSync(()->{ context.getSharedPreferences("faceclaw-external-apps",0).edit().putString(component+":pin",identity).commit(); manager.refresh(); });
  assertTrue("Fixture handshake failed",connected.await(5,TimeUnit.SECONDS)); return component;
 }
 void send(String component,String type,String json) { getInstrumentation().runOnMainSync(()->manager.send(component,type,json)); }
 void open(String component) { send(component,"open","{\"width\":32,\"height\":16}"); send(component,"visibility","{\"visible\":true,\"screenOn\":true}"); }
 void settle() throws Exception { Thread.sleep(150); getInstrumentation().waitForIdleSync(); }
 private String declarations(String feature,String configuration) { return "{\"declarations\":[{\"feature\":\""+feature+"\",\"enabled\":true,\"configuration\":"+configuration+"}]}"; }
 private void grantExtension(String component,String feature,boolean granted) {
  runOnMainSync(()->{ context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(component+":extension:"+feature,granted).commit(); manager.refresh(); });
 }
 public void testSettingsTargetRequiresSamePackageUidExportAndNoPermission() throws Exception {
  android.content.pm.ServiceInfo service=new android.content.pm.ServiceInfo();
  service.packageName=PKG; service.applicationInfo=new android.content.pm.ApplicationInfo(); service.applicationInfo.uid=12345;
  android.content.pm.ActivityInfo activity=new android.content.pm.ActivityInfo();
  activity.packageName=PKG; activity.applicationInfo=new android.content.pm.ApplicationInfo(); activity.applicationInfo.uid=12345;
  activity.exported=true; activity.enabled=true; activity.applicationInfo.enabled=true;
  assertTrue("Own public settings allowed",AppSettingsIntent.allowedTarget(service,activity));
  activity.packageName="com.android.settings"; assertFalse(AppSettingsIntent.allowedTarget(service,activity)); activity.packageName=PKG;
  activity.applicationInfo.uid=9999; assertFalse(AppSettingsIntent.allowedTarget(service,activity)); activity.applicationInfo.uid=12345;
  activity.exported=false; assertFalse(AppSettingsIntent.allowedTarget(service,activity)); activity.exported=true;
  activity.enabled=false; assertFalse(AppSettingsIntent.allowedTarget(service,activity)); activity.enabled=true;
  activity.applicationInfo.enabled=false; assertFalse(AppSettingsIntent.allowedTarget(service,activity)); activity.applicationInfo.enabled=true;
  activity.permission="android.permission.MANAGE_USERS"; assertFalse(AppSettingsIntent.allowedTarget(service,activity));
  assertFalse(AppSettingsIntent.allowedTarget(service,null));
  assertEquals(null,AppSettingsIntent.resolve(context,null));
 }
 public void testSettingsResolutionIsExplicitAndDoesNotApproveApp() throws Exception {
  android.content.pm.ServiceInfo service=context.getPackageManager().getServiceInfo(new ComponentName(PKG,PKG+".CanvasService"),0);
  Intent intent=AppSettingsIntent.resolve(context,service);
  assertTrue("Settings entry point resolves",intent!=null);
  assertEquals(new ComponentName(PKG,PKG+".SettingsActivity"),intent.getComponent());
  assertEquals(AppSettingsIntent.ACTION,intent.getAction());
  assertEquals(null,intent.getExtras()); assertEquals(null,intent.getData()); assertEquals(null,intent.getClipData()); assertEquals(0,intent.getFlags());
  assertFalse(context.getSharedPreferences("faceclaw-external-apps",0).contains(PKG+"/"+PKG+".CanvasService:pin"));
  service.packageName="com.faceclaw.no.installed.app";
  assertEquals(null,AppSettingsIntent.resolve(context,service));
 }
 public void testNavigationDoubleTapIsBoundedAndOptional() throws Exception {
  for(String value:new String[]{"back","sleep"}) assertEquals(value,ExtensionContract.configuration("ui.navigation",new org.json.JSONObject().put("doubleTap",value)).getString("doubleTap"));
  assertFalse(ExtensionContract.configuration("ui.navigation",new org.json.JSONObject().put("hold","app-menu")).has("doubleTap"));
  for(Object value:new Object[]{"switcher","execute-native","sleep|back",true,1,org.json.JSONObject.NULL}) {
   try { ExtensionContract.configuration("ui.navigation",new org.json.JSONObject().put("doubleTap",value)); throw new AssertionError("Untrusted double tap accepted"); }
   catch(IllegalArgumentException expected) {}
  }
 }
 public void testExtensionDeclarationsRequireSeparateGrantAndPin() throws Exception {
  String c=approve("CanvasService"); send(c,"test-publish-extensions",declarations("ui.typography","{\"size\":17}")); settle();
  org.json.JSONArray features=new org.json.JSONObject(manager.extensionsJson()).getJSONArray("features");
  org.json.JSONObject typography=null; for(int i=0;i<features.length();i++) if(features.getJSONObject(i).getString("feature").equals("ui.typography")) typography=features.getJSONObject(i);
  assertEquals("",typography.getString("component")); assertEquals(1,typography.getJSONArray("contenders").length());
  grantExtension(c,"ui.typography",true);
  features=new org.json.JSONObject(manager.extensionsJson()).getJSONArray("features");
  for(int i=0;i<features.length();i++) if(features.getJSONObject(i).getString("feature").equals("ui.typography")) typography=features.getJSONObject(i);
  assertEquals(c,typography.getString("component")); assertEquals(17,typography.getJSONObject("configuration").getInt("size"));
  runOnMainSync(()->{ context.getSharedPreferences("faceclaw-external-apps",0).edit().putString(c+":pin","wrong-pin").commit(); manager.refresh(); });
  assertFalse(manager.extensionsJson().contains(c));
 }
 public void testExtensionContractRejectsUnknownKeysAndDependencies() throws Exception {
  for(String json:new String[]{declarations("ui.typography","{\"size\":21}"),declarations("ui.typography","{\"hostPreference\":true}"),declarations("ui.navigation","{\"hold\":\"execute-native\"}"),declarations("unknown","{}")}) {
   try { ExtensionContract.declarations(new org.json.JSONObject(json).getJSONArray("declarations")); throw new AssertionError("Invalid extension accepted"); } catch(IllegalArgumentException expected) {}
  }
  ExtensionContract.declarations(new org.json.JSONObject(declarations("ui.typography","{\"font\":\"Inter_18pt-Regular.ttf\",\"size\":17}")).getJSONArray("declarations"));
 }
 public void testFullStandaloneBundlePublishesEverySupportedConfiguration() throws Exception {
  java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
  try(java.io.InputStream source=getContext().getAssets().open("full-extension-bundle.json")) { byte[] block=new byte[4096]; int read; while((read=source.read(block))!=-1) bytes.write(block,0,read); }
  String json=new String(bytes.toByteArray(),java.nio.charset.StandardCharsets.UTF_8);
  org.json.JSONArray declarations=ExtensionContract.declarations(new org.json.JSONObject(json).getJSONArray("declarations")); assertEquals(11,declarations.length());
  String c=approve("CanvasService"); send(c,"test-publish-extensions",json); settle();
  org.json.JSONArray features=new org.json.JSONObject(manager.extensionsJson()).getJSONArray("features"); assertEquals(11,features.length());
  for(int i=0;i<features.length();i++) { org.json.JSONArray contenders=features.getJSONObject(i).getJSONArray("contenders"); assertEquals(1,contenders.length()); assertEquals(c,contenders.getJSONObject(0).getString("component")); assertTrue("Bundle feature enabled",contenders.getJSONObject(0).getBoolean("enabled")); }
  grantExtension(c,"ui.window-layout",true); features=new org.json.JSONObject(manager.extensionsJson()).getJSONArray("features");
  for(int i=0;i<features.length();i++) if(features.getJSONObject(i).getString("feature").equals("ui.window-layout")) { assertEquals(c,features.getJSONObject(i).getString("component")); assertEquals("medium",features.getJSONObject(i).getJSONObject("configuration").getString("ownHeightMode")); assertEquals("viewport",features.getJSONObject(i).getJSONObject("configuration").getString("inputDialogs")); }
 }
 public void testSharedStyleRejectsPathsBeforeAssetAccessAndResets() throws Exception {
  AtomicInteger accesses=new AtomicInteger();
  Context wrapped=new ContextWrapper(context) { @Override public android.content.res.AssetManager getAssets() { accesses.incrementAndGet(); return super.getAssets(); } };
  Ui.applySharedStyle(wrapped,new org.json.JSONObject("{\"font\":\"../../private-file.ttf\",\"size\":17}"));
  assertEquals(0,accesses.get()); assertEquals(Float.valueOf(16),Float.valueOf(Ui.style().size));
  Ui.applySharedStyle(wrapped,new org.json.JSONObject("{\"font\":\"Inter_18pt-Regular.ttf\",\"size\":17,\"raster\":\"crisp\"}"));
  assertEquals(1,accesses.get()); assertEquals(Float.valueOf(17),Float.valueOf(Ui.style().size)); assertFalse(Ui.style().antiAlias);
  Ui.resetSharedStyle(); assertEquals(Float.valueOf(16),Float.valueOf(Ui.style().size));
 }
 public void testExtensionRequestsAreWinnerBoundAndSingleUse() throws Exception {
  String c=approve("CanvasService"); send(c,"test-publish-extensions",declarations("assistant","{}")); settle();
  assertFalse(manager.sendExtension(c,"assistant","request","{\"requestId\":\"request-1\"}"));
  grantExtension(c,"assistant",true);
  runOnMainSync(()->assertTrue("Granted request dispatched",manager.sendExtension(c,"assistant","request","{\"requestId\":\"request-1\"}")));
  settle(); assertEquals(1,extensionResults.get());
  grantExtension(c,"assistant",false); assertFalse(manager.sendExtension(c,"assistant","request","{\"requestId\":\"request-2\"}"));
 }
 public void testAttemptedProviderDispatchCannotAuthorizeFallback() throws Exception {
  String c=approve("CanvasService"); send(c,"test-publish-extensions",declarations("assistant","{}")); settle(); grantExtension(c,"assistant",true);
  java.lang.reflect.Field connections=FaceclawExternalApps.class.getDeclaredField("connections"); connections.setAccessible(true);
  Object connection=((java.util.Map<?,?>)connections.get(manager)).get(c);
  java.lang.reflect.Field remote=connection.getClass().getDeclaredField("remote"); remote.setAccessible(true);
  android.os.Messenger original=(android.os.Messenger)remote.get(connection);
  android.os.Messenger broken=new android.os.Messenger(new android.os.Binder() { @Override protected boolean onTransact(int code,android.os.Parcel data,android.os.Parcel reply,int flags) throws android.os.RemoteException { throw new android.os.RemoteException("Synthetic ambiguous transport"); } });
  runOnMainSync(()->{ try {
   remote.set(connection,broken);
   assertTrue("Attempted dispatch must remain accepted/uncertain",manager.sendExtension(c,"assistant","request","{\"requestId\":\"uncertain-request\"}"));
  } catch(Exception error) { throw new AssertionError(error); } finally { try { remote.set(connection,original); } catch(Exception ignored) {} } });
  assertEquals(1,extensionTimeouts.get()); assertEquals(0,extensionResults.get());
 }
 public void testExtensionSurfacesRequireWinnerVisibilityAndOwnStream() throws Exception {
  String c=approve("CanvasService"); send(c,"test-publish-extensions",declarations("ui.launcher","{}")); settle();
  assertFalse(manager.openExtensionSurface(c,"ui.launcher",32,16)); assertFalse(manager.sendExtensionPointer(c,"ui.launcher",0,0,32,16)); grantExtension(c,"ui.launcher",true);
  runOnMainSync(()->{ assertTrue("Granted surface opened",manager.openExtensionSurface(c,"ui.launcher",32,16)); manager.setExtensionSurfaceVisibility(c,"ui.launcher",true,true); }); settle();
  runOnMainSync(()->{ assertTrue("Visible exact viewport pointer",manager.sendExtensionPointer(c,"ui.launcher",0,0,32,16)); assertFalse(manager.sendExtensionPointer(c,"ui.launcher",32,0,32,16)); assertFalse(manager.sendExtensionPointer(c,"ui.launcher",-1,0,32,16)); assertFalse(manager.sendExtensionPointer(c,"ui.launcher",0,0,640,452)); });
  assertEquals(1,extensionFrames.get()); assertEquals(0,frames.get()); assertEquals(0,extensionTransparent); assertEquals(1,extensionBlack);
  runOnMainSync(()->manager.setExtensionSurfaceVisibility(c,"ui.launcher",true,false)); settle(); assertEquals(1,extensionFrames.get()); assertFalse(manager.sendExtensionPointer(c,"ui.launcher",0,0,32,16));
  grantExtension(c,"ui.launcher",false); runOnMainSync(()->manager.setExtensionSurfaceVisibility(c,"ui.launcher",true,true)); settle(); assertEquals(1,extensionFrames.get());
 }
 private boolean[] proposedChoices(String component) throws Exception {
  java.lang.reflect.Method method=FaceclawExternalApps.class.getDeclaredMethod("approvalChoices",String.class); method.setAccessible(true);
  return (boolean[])method.invoke(manager,component);
 }
 private boolean saveApproval(String component,String pin,boolean[] choices) throws Exception {
  android.content.pm.ServiceInfo service=context.getPackageManager().getServiceInfo(ComponentName.unflattenFromString(component),android.content.pm.PackageManager.GET_META_DATA);
  java.lang.reflect.Method method=FaceclawExternalApps.class.getDeclaredMethod("approveSelection",android.content.pm.ServiceInfo.class,String.class,boolean[].class); method.setAccessible(true);
  AtomicBoolean saved=new AtomicBoolean(); AtomicReference<Throwable> error=new AtomicReference<>();
  runOnMainSync(()->{ try { saved.set((Boolean)method.invoke(manager,service,pin,choices)); if(saved.get()) manager.refresh(); } catch(Throwable failure) { error.set(failure); } });
  if(error.get()!=null) throw new AssertionError(error.get());
  return saved.get();
 }
 private void revokeThroughPolicy(String component) throws Exception {
  java.lang.reflect.Method method=FaceclawExternalApps.class.getDeclaredMethod("revokeApproval",String.class); method.setAccessible(true);
  AtomicReference<Throwable> error=new AtomicReference<>();
  runOnMainSync(()->{ try { method.invoke(manager,component); } catch(Throwable failure) { error.set(failure); } });
  if(error.get()!=null) throw new AssertionError(error.get());
 }
 private void assertChoices(boolean[] expected,boolean[] actual) { assertTrue("Permission choices differ",java.util.Arrays.equals(expected,actual)); }
 public void testFreshApprovalDefaultsRequireExplicitSaveAndSuppressionIsScoped() throws Exception {
  String c=PKG+"/"+PKG+".CanvasService";
  android.content.SharedPreferences prefs=context.getSharedPreferences("faceclaw-external-apps",0);
  java.util.Map<String,?> before=new java.util.HashMap<>(prefs.getAll());
  boolean[] checked=proposedChoices(c); assertChoices(new boolean[]{true,true,true,true},checked);
  assertEquals(before,new java.util.HashMap<>(prefs.getAll())); assertFalse(manager.allows(c,"notifications")); assertFalse(manager.isSourceSuppressed(PKG+".source"));
  assertTrue("Approval save",saveApproval(c,PackageIdentity.forPackage(context,PKG),checked));
  assertTrue("Approved fixture handshake",connected.await(5,TimeUnit.SECONDS));
  for(String capability:new String[]{"notifications","dictation","previews","suppress"}) { assertTrue("Saved checked permission",prefs.getBoolean(c+":"+capability,false)); assertTrue("Connected capability",manager.allows(c,capability)); }
  assertTrue("Declared source suppressed",manager.isSourceSuppressed(PKG+".source"));
  assertFalse(manager.isSourceSuppressed("unrelated.app")); assertFalse(manager.isSourceSuppressed(""));
  prefs.edit().putBoolean(c+":unknown-capability",true).commit(); assertFalse(manager.allows(c,"unknown-capability"));
  revokeThroughPolicy(c);
  assertFalse(manager.isConnected(c)); assertFalse(manager.isSourceSuppressed(PKG+".source"));
  for(String capability:new String[]{"pin","notifications","dictation","previews","suppress"}) assertFalse(prefs.contains(c+":"+capability));
  assertChoices(new boolean[]{true,true,true,true},proposedChoices(c));
 }
 public void testLegacyAbsentChoicesStayLegacyAcrossRefreshAndReapproval() throws Exception {
  String c=approve("CanvasService");
  android.content.SharedPreferences prefs=context.getSharedPreferences("faceclaw-external-apps",0);
  java.util.Map<String,?> before=new java.util.HashMap<>(prefs.getAll());
  assertChoices(new boolean[]{false,false,true,false},proposedChoices(c));
  runOnMainSync(manager::refresh); assertEquals(before,new java.util.HashMap<>(prefs.getAll()));
  assertFalse(manager.allows(c,"notifications")); assertFalse(manager.allows(c,"dictation")); assertFalse(manager.allows(c,"suppress")); assertTrue("Legacy preview default",manager.allows(c,"previews"));
  assertTrue("Reapproval",saveApproval(c,PackageIdentity.forPackage(context,PKG),proposedChoices(c)));
  assertChoices(new boolean[]{false,false,true,false},proposedChoices(c));
 }
 public void testExplicitUncheckedChoicesSurviveRefreshAndChangedSignerReapproval() throws Exception {
  String c=PKG+"/"+PKG+".CanvasService"; String identity=PackageIdentity.forPackage(context,PKG);
  boolean[] chosen={false,true,false,false};
  assertTrue("Unchecked approval",saveApproval(c,identity,chosen)); assertTrue("Fixture handshake",connected.await(5,TimeUnit.SECONDS));
  runOnMainSync(manager::refresh); assertChoices(chosen,proposedChoices(c));
  context.getSharedPreferences("faceclaw-external-apps",0).edit().putString(c+":pin","old-signer").commit(); runOnMainSync(manager::refresh);
  assertFalse(manager.isConnected(c)); assertChoices(chosen,proposedChoices(c));
  assertTrue("Explicit new signer approval",saveApproval(c,identity,proposedChoices(c))); assertChoices(chosen,proposedChoices(c));
 }
 public void testChangedIdentityBeforeApprovalCannotWriteDefaults() throws Exception {
  String c=PKG+"/"+PKG+".CanvasService";
  android.content.SharedPreferences prefs=context.getSharedPreferences("faceclaw-external-apps",0);
  java.util.Map<String,?> before=new java.util.HashMap<>(prefs.getAll());
  assertFalse(saveApproval(c,"stale-or-forged-identity",proposedChoices(c)));
  assertEquals(before,new java.util.HashMap<>(prefs.getAll())); assertFalse(manager.installedJson().contains(PKG));
 }
 public void testPhoneSettingsIntentCannotGrantAppOrCapabilities() throws Exception {
  android.content.SharedPreferences prefs=context.getSharedPreferences("faceclaw-external-apps",0);
  java.util.Map<String,?> before=new java.util.HashMap<>(prefs.getAll());
  Intent forged=new Intent(context,FaceclawAppSettingsActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
   .putExtra("appPackage",PKG).putExtra("pin",PackageIdentity.forPackage(context,PKG))
   .putExtra("approve",true).putExtra("notifications",true).putExtra("dictation",true);
  android.app.Activity activity=startActivitySync(forged);
  try { settle(); assertEquals(before,new java.util.HashMap<>(prefs.getAll())); assertEquals("[]",manager.installedJson()); }
  finally { runOnMainSync(activity::finish); }
 }
 public void testColdPhoneSettingsConnectsPreviouslyApprovedAppWithoutChangingGrants() throws Exception {
  String component=PKG+"/"+PKG+".CanvasService";
  android.content.SharedPreferences prefs=context.getSharedPreferences("faceclaw-external-apps",0);
  // Simulate a fresh host process: durable approval exists, but no main-screen refresh ran.
  prefs.edit().putString(component+":pin",PackageIdentity.forPackage(context,PKG)).commit();
  java.util.Map<String,?> before=new java.util.HashMap<>(prefs.getAll());
  assertFalse(manager.isConnected(component));
  android.app.Activity activity=startActivitySync(new Intent(context,FaceclawAppSettingsActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("appPackage",PKG));
  try {
   assertTrue("Cold phone settings must initialize approved app connections",connected.await(5,TimeUnit.SECONDS));
   assertTrue("Saved mutual host selection reconnects",manager.isConnected(component));
   assertEquals(before,new java.util.HashMap<>(prefs.getAll()));
  } finally { runOnMainSync(activity::finish); }
 }
 public void testTransportTimingAndCoalescing() throws Exception {
  String c=approve("CanvasService");
  for(int[] size:new int[][]{{576,260},{640,452}}) {
   send(c,"open",Protocol.object("width",size[0],"height",size[1]).toString()); send(c,"visibility","{\"visible\":true,\"screenOn\":true}");
   settle(); timings.clear();
   for(int sample=0;sample<20;sample++) {
    int before=frames.get(); send(c,"render","{}");
    for(int retry=0;retry<60&&frames.get()==before;retry++) Thread.sleep(20);
    assertTrue("Frame timeout",frames.get()>before); Thread.sleep(20);
   }
   java.util.List<Double> sorted=new java.util.ArrayList<>(timings); java.util.Collections.sort(sorted);
   assertTrue("Timestamp samples missing",sorted.size()>=20);
   measurements.append(context.getPackageName()).append(" ").append(size[0]).append("x").append(size[1]).append(" submitBitmap-to-private-copy ms median=").append(sorted.get(sorted.size()/2)).append(" p95=").append(sorted.get((int)Math.ceil(sorted.size()*0.95)-1)).append(" samples=").append(sorted.size()).append("\n");
  }
  Thread.sleep(30); int before=frames.get(); send(c,"burst","{\"count\":40}"); Thread.sleep(500);
  int delivered=frames.get()-before; assertTrue("Burst queue not bounded",delivered>=1&&delivered<=2);
  measurements.append("burst submitted=40 delivered=").append(delivered).append(" coalesced-or-throttled=").append(40-delivered).append("\n");
 }
 public void testVoiceSearchRequiresDictationAndVisibleSelectedSession() throws Exception {
  String c=approve("CanvasService"); open(c);
  send(c,"test-search-request","{}"); settle(); assertEquals(0,searchRequests.get());
  context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":dictation",true).commit();
  send(c,"test-search-request","{}"); settle(); assertEquals(1,searchRequests.get());
  send(c,"visibility","{\"visible\":false,\"screenOn\":true}"); send(c,"test-search-request","{}"); settle(); assertEquals(1,searchRequests.get());
  send(c,"visibility","{\"visible\":true,\"screenOn\":false}"); send(c,"test-search-request","{}"); settle(); assertEquals(1,searchRequests.get());
  revokeThroughPolicy(c); send(c,"test-search-request","{}"); settle(); assertEquals(1,searchRequests.get());
 }
 public void testSystemMenuRequiresOwnOpenVisibleAwakeSession() throws Exception {
  String c=approve("CanvasService"); send(c,"test-system-menu","{}"); settle(); assertEquals(0,systemMenuRequests.get());
  open(c); send(c,"test-system-menu","{}"); settle(); assertEquals(1,systemMenuRequests.get()); assertEquals("{}",systemMenuPayload);
  send(c,"visibility","{\"visible\":false,\"screenOn\":true}"); send(c,"test-system-menu","{}"); settle(); assertEquals(1,systemMenuRequests.get());
  send(c,"visibility","{\"visible\":true,\"screenOn\":false}"); send(c,"test-system-menu","{}"); settle(); assertEquals(1,systemMenuRequests.get());
  open(c); send(c,"close","{}"); send(c,"test-system-menu","{}"); settle(); assertEquals(1,systemMenuRequests.get());
  revokeThroughPolicy(c); send(c,"test-system-menu","{}"); settle(); assertEquals(1,systemMenuRequests.get());
 }
 public void testSystemMenuRejectsStaleSessionAndForgedUidAndStripsForeignTarget() throws Exception {
  String c=approve("AdversarialService"); open(c);
  send(c,"fixture","{\"attack\":\"system-menu-stale\"}"); settle(); assertEquals(0,systemMenuRequests.get());
  java.lang.reflect.Field field=FaceclawExternalApps.class.getDeclaredField("connections"); field.setAccessible(true);
  Object connection=((java.util.Map<?,?>)field.get(manager)).get(c);
  java.lang.reflect.Field inboxField=connection.getClass().getDeclaredField("inbox"), sessionField=connection.getClass().getDeclaredField("session"); inboxField.setAccessible(true); sessionField.setAccessible(true);
  android.os.Messenger stolen=(android.os.Messenger)inboxField.get(connection);
  android.os.Message message=Protocol.message(Protocol.EVENT,(String)sessionField.get(connection),"request-system-menu",new org.json.JSONObject());
  message.sendingUid=context.getPackageManager().getApplicationInfo(PKG,0).uid;
  stolen.send(message); settle(); assertEquals(0,systemMenuRequests.get());
  send(c,"fixture","{\"attack\":\"system-menu-valid\"}"); settle(); assertEquals(1,systemMenuRequests.get()); assertEquals("{}",systemMenuPayload);
 }
 public void testOwnContentAndHostRefinementRequireIndependentVisibleGrants() throws Exception {
  String c=approve("CanvasService"); open(c);
  send(c,"test-publish-extensions",declarations("notification-content","{}")); settle();
  send(c,"test-own-notifications","{}"); send(c,"test-host-refinement","{}"); settle(); assertEquals(0,ownRequests.get()); assertEquals(0,refineRequests.get());
  grantExtension(c,"notification-content",true);
  send(c,"test-own-notifications","{}"); send(c,"test-host-refinement","{}"); settle(); assertEquals(1,ownRequests.get()); assertEquals(0,refineRequests.get());
  context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":dictation",true).commit();
  send(c,"test-host-refinement","{}"); settle(); assertEquals(1,refineRequests.get());
  send(c,"visibility","{\"visible\":false,\"screenOn\":true}"); send(c,"test-own-notifications","{}"); send(c,"test-host-refinement","{}"); settle(); assertEquals(1,ownRequests.get()); assertEquals(1,refineRequests.get());
  send(c,"visibility","{\"visible\":true,\"screenOn\":false}"); send(c,"test-own-notifications","{}"); send(c,"test-host-refinement","{}"); settle(); assertEquals(1,ownRequests.get()); assertEquals(1,refineRequests.get());
  open(c); grantExtension(c,"notification-content",false); context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":dictation",false).commit();
  send(c,"test-own-notifications","{}"); send(c,"test-host-refinement","{}"); settle(); assertEquals(1,ownRequests.get()); assertEquals(1,refineRequests.get());
 }
 public void testNotificationReplyRequiresGrantsLiveTokenAndSingleUseResult() throws Exception {
  String c=approve("CanvasService");
  String valid=Protocol.object("id","fixture-message","target","fixture-target","replyToken","fixture-token","text","Exact reviewed reply","confirmed",true).toString();
  assertFalse(manager.replyToNotification(c,valid));
  getInstrumentation().runOnMainSync(()->context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":notifications",true).putBoolean(c+":dictation",true).commit());
  send(c,"capabilities",Protocol.object("notifications",true,"dictation",true,"notificationReplies",true).toString());
  send(c,"test-publish-reply","{}"); settle(); assertEquals(1,notifications.get());
  assertFalse(manager.replyToNotification(c,Protocol.object("id","fixture-message","target","fixture-target","replyToken","fixture-token","text","x","confirmed",false).toString()));
  send(c,"notification-reply",Protocol.object("id","fixture-message","target","foreign-target","replyToken","fixture-token","text","x","confirmed",true).toString()); settle(); assertEquals(0,replyResults.get());
  assertTrue("Authorized notification reply",manager.replyToNotification(c,valid)); settle(); assertEquals(1,replyResults.get());
  assertTrue("Duplicate enqueued for SDK rejection",manager.replyToNotification(c,valid)); settle(); assertEquals(1,replyResults.get());
  send(c,"test-publish-reply","{}"); settle(); manager.replyToNotification(c,valid); settle(); assertEquals(1,replyResults.get());
  getInstrumentation().runOnMainSync(()->context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":dictation",false).commit());
  assertFalse(manager.replyToNotification(c,valid));
  send(c,"test-publish-reply",Protocol.object("token","unconsumed-token").toString()); settle();
  send(c,"capabilities",Protocol.object("notifications",true,"dictation",false,"notificationReplies",true).toString());
  send(c,"capabilities",Protocol.object("notifications",true,"dictation",true,"notificationReplies",true).toString());
  getInstrumentation().runOnMainSync(()->context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":dictation",true).commit());
  manager.replyToNotification(c,valid.replace("fixture-token","unconsumed-token")); settle(); assertEquals(1,replyResults.get());
 }
 public void testRestoredApprovalBackupRequiresFreshConsent() throws Exception {
  final String namespace="faceclaw-fixture-backup-test";
  try {
   android.content.SharedPreferences prefs=ApprovalStore.open(context,namespace); prefs.edit().putString("pin","synthetic-restored-grant").commit();
   assertTrue("Test marker removal",new java.io.File(context.getNoBackupFilesDir(),namespace+".installation").delete());
   assertFalse(ApprovalStore.open(context,namespace).contains("pin"));
  } finally { context.getSharedPreferences(namespace,0).edit().clear().commit(); new java.io.File(context.getNoBackupFilesDir(),namespace+".installation").delete(); }
 }
 public void testLocalSettingsCatalogDoesNotGrantOrActivateApps() throws Exception {
  settle(); assertTrue("Installed catalog includes an unapproved app",manager.androidAppsJson().contains(PKG));
  assertFalse(manager.installedJson().contains(PKG));
  org.json.JSONArray catalog=new org.json.JSONArray(manager.androidAppsJson());
  for(int i=0;i<catalog.length();i++) {
   String pkg=catalog.getJSONObject(i).getString("packageName"); boolean compatible=false;
   for(android.content.pm.ResolveInfo candidate:context.getPackageManager().queryIntentServices(new Intent(Protocol.ACTION).setPackage(pkg),android.content.pm.PackageManager.GET_META_DATA)) {
    android.content.pm.ServiceInfo service=candidate.serviceInfo;
    if(service.exported&&service.enabled&&service.applicationInfo.enabled&&service.metaData!=null&&service.metaData.getInt("com.faceclaw.PROTOCOL_MAJOR",0)==Protocol.VERSION)compatible=true;
   }
   assertTrue("Only compatible Faceclaw packages appear in settings: "+pkg,compatible);
  }
  assertFalse(manager.openAndroidAppSettings(null,PKG));
  assertFalse(manager.prioritizeExtension("unknown.feature",PKG+"/Missing"));
  assertFalse(manager.prioritizeExtension("transcription",PKG+"/Missing"));
  assertFalse(manager.installedJson().contains(PKG));
 }
 public void testUnapprovedPackageIsNotDiscoveredAsLaunchable() throws Exception { settle(); assertFalse(manager.installedJson().contains(PKG)); }
 public void testMutualSdkHandshakeFrameSleepAndRevocation() throws Exception {
  String c=approve("CanvasService"); open(c); for(int i=0;i<40&&frames.get()==0;i++) settle(); assertTrue("SharedMemory frame absent",frames.get()>0);
  int count=frames.get(); send(c,"visibility","{\"visible\":true,\"screenOn\":false}"); send(c,"render","{}"); settle(); assertEquals(count,frames.get());
  getInstrumentation().runOnMainSync(()->{ context.getSharedPreferences("faceclaw-external-apps",0).edit().remove(c+":pin").commit(); manager.refresh(); });
  assertFalse(manager.isConnected(c)); send(c,"render","{}"); settle(); assertEquals(count,frames.get());
 }
 public void testHostRejectsBadFrameSessionGenerationLengthAndCapabilities() throws Exception {
  String c=approve("AdversarialService"); open(c);
  for(String attack:new String[]{"session","generation","length","notification"}) { send(c,"fixture",Protocol.object("attack",attack).toString()); settle(); }
  assertEquals(0,frames.get()); assertEquals(0,notifications.get());
  send(c,"fixture","{\"attack\":\"valid\"}"); settle(); assertEquals(1,frames.get());
  getInstrumentation().runOnMainSync(()->context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":notifications",true).commit());
  send(c,"fixture","{\"attack\":\"notification\"}"); settle(); assertEquals(1,notifications.get());
 }
 public void testForgedSendingUidDoesNotAuthorizeStolenCallback() throws Exception {
  String c=approve("AdversarialService");
  getInstrumentation().runOnMainSync(()->context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(c+":notifications",true).commit());
  java.lang.reflect.Field field=FaceclawExternalApps.class.getDeclaredField("connections"); field.setAccessible(true);
  Object connection=((java.util.Map<?,?>)field.get(manager)).get(c);
  java.lang.reflect.Field inboxField=connection.getClass().getDeclaredField("inbox"), sessionField=connection.getClass().getDeclaredField("session"); inboxField.setAccessible(true); sessionField.setAccessible(true);
  android.os.Messenger stolen=(android.os.Messenger)inboxField.get(connection);
  android.os.Message message=Protocol.message(Protocol.EVENT,(String)sessionField.get(connection),"notification",Protocol.object("id","x","target","synthetic","title","Synthetic","text","Synthetic"));
  message.sendingUid=context.getPackageManager().getApplicationInfo(PKG,0).uid;
  stolen.send(message); settle(); assertEquals(0,notifications.get());
 }
 public void testHostConsentRejectsNonActivityPendingIntent() throws Exception {
  if(android.os.Build.VERSION.SDK_INT<31) return;
  String c=approve("AdversarialService"); send(c,"fixture",Protocol.object("attack","consent-broadcast").toString()); settle();
  java.lang.reflect.Field field=FaceclawExternalApps.class.getDeclaredField("connections"); field.setAccessible(true);
  Object connection=((java.util.Map<?,?>)field.get(manager)).get(c);
  java.lang.reflect.Field consentField=connection.getClass().getDeclaredField("consent"); consentField.setAccessible(true);
  assertEquals(null,consentField.get(connection));
 }
 public void testChangedSignerPinCannotReconnect() throws Exception {
  String c=approve("AdversarialService");
  getInstrumentation().runOnMainSync(()->{ context.getSharedPreferences("faceclaw-external-apps",0).edit().putString(c+":pin","wrong-signer").commit(); manager.refresh(); });
  assertFalse(manager.isConnected(c)); assertFalse(manager.installedJson().contains(PKG));
 }
 private Object field(Object target,String name) throws Exception { java.lang.reflect.Field f=target.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(target); }
 private Object frameStream(String component,boolean extension) throws Exception {
  Object connection=((java.util.Map<?,?>)field(manager,"connections")).get(component);
  return extension?((java.util.Map<?,?>)field(connection,"surfaces")).get("ui.launcher"):connection;
 }
 private void delayFrameWindow(Object stream,int milliseconds) throws Exception {
  Object delivery=field(stream,"frames");java.lang.reflect.Field last=delivery.getClass().getDeclaredField("lastFrame");last.setAccessible(true);
  // Extend just this test's window so cancellation remains deterministic under emulator load.
  runOnMainSync(()->{try{last.setLong(delivery,android.os.SystemClock.elapsedRealtime()+milliseconds);}catch(Exception error){throw new AssertionError(error);}});
 }
 private void awaitFrameSequence(Object stream,long after) throws Exception {
  for(int i=0;i<120;i++){waitForIdleSync();if(((Long)field(stream,"sequence"))>after)return;Thread.sleep(5);}
  throw new AssertionError("Synthetic frame never reached validation");
 }
 private String prepareFrameStream(boolean extension) throws Exception {
  connected=new CountDownLatch(1);String component=approve("AdversarialService");open(component);
  if(extension){
   send(component,"fixture","{\"attack\":\"publish-launcher\"}");settle();grantExtension(component,"ui.launcher",true);
   runOnMainSync(()->{assertTrue("Open synthetic launcher",manager.openExtensionSurface(component,"ui.launcher",32,16));manager.setExtensionSurfaceVisibility(component,"ui.launcher",true,true);});
  }
  return component;
 }
 private void finalFrameAfterQuiescence(boolean extension,boolean mutable) throws Exception {
  String component=prepareFrameStream(extension);Object stream=frameStream(component,extension);
  delayFrameWindow(stream,180);long before=(Long)field(stream,"sequence");
  send(component,"fixture",Protocol.object("attack",(extension?"extension":"frame")+(mutable?"-memory":"-burst")).toString());
  awaitFrameSequence(stream,before);Thread.sleep(260);waitForIdleSync();
  assertEquals(mutable?7:4,extension?latestExtensionFrame:latestFrame);
  assertEquals(1,extension?extensionFrames.get():frames.get());
  assertEquals(null,field(field(stream,"frames"),"pending"));
 }
 public void testRegularFinalFrameSurvivesThrottleAfterSenderStops() throws Exception { finalFrameAfterQuiescence(false,false); }
 public void testExtensionFinalFrameSurvivesThrottleAfterSenderStops() throws Exception { finalFrameAfterQuiescence(true,false); }
 public void testRegularDeferredFrameOwnsCopyBeforeAckAllowsMemoryMutation() throws Exception { finalFrameAfterQuiescence(false,true); }
 public void testExtensionDeferredFrameOwnsCopyBeforeAckAllowsMemoryMutation() throws Exception { finalFrameAfterQuiescence(true,true); }
 private void staleQueuedFrames(boolean extension) throws Exception {
  for(String change:extension?new String[]{"hide","sleep","resize","close","grant","revoke","disconnect","pin"}:new String[]{"hide","sleep","resize","close","revoke","disconnect","pin"}) {
   String component=prepareFrameStream(extension);Object stream=frameStream(component,extension);Object delivery=field(stream,"frames");
   delayFrameWindow(stream,1000);long sequence=(Long)field(stream,"sequence");int before=extension?extensionFrames.get():frames.get();
   send(component,"fixture",Protocol.object("attack",extension?"extension-burst":"frame-burst").toString());
   awaitFrameSequence(stream,sequence);Runnable pending=(Runnable)field(delivery,"pending");assertTrue("Frame pending before "+change,pending!=null);
   if(change.equals("revoke"))revokeThroughPolicy(component);
   else if(change.equals("disconnect")){
    java.lang.reflect.Method method=FaceclawExternalApps.class.getDeclaredMethod("disconnect",String.class,boolean.class);method.setAccessible(true);
    runOnMainSync(()->{try{method.invoke(manager,component,false);}catch(Exception error){throw new AssertionError(error);}});
   } else if(change.equals("pin"))context.getSharedPreferences("faceclaw-external-apps",0).edit().putString(component+":pin","changed-signer").commit();
   else if(extension){
    if(change.equals("grant"))grantExtension(component,"ui.launcher",false);
    else runOnMainSync(()->{
     if(change.equals("hide"))manager.setExtensionSurfaceVisibility(component,"ui.launcher",false,true);
     if(change.equals("sleep"))manager.setExtensionSurfaceVisibility(component,"ui.launcher",true,false);
     if(change.equals("resize"))manager.openExtensionSurface(component,"ui.launcher",64,32);
     if(change.equals("close"))manager.closeExtensionSurface(component,"ui.launcher");
    });
   } else {
    if(change.equals("hide"))send(component,"visibility","{\"visible\":false,\"screenOn\":true}");
    if(change.equals("sleep"))send(component,"visibility","{\"visible\":true,\"screenOn\":false}");
    if(change.equals("resize"))send(component,"resize","{\"width\":64,\"height\":32}");
    if(change.equals("close"))send(component,"close","{}");
   }
   if(!change.equals("pin"))assertEquals(null,field(delivery,"pending"));
   // Even a callback already dequeued before cancellation must recheck live authority.
   runOnMainSync(pending);assertEquals(before,extension?extensionFrames.get():frames.get());
   revokeThroughPolicy(component);settle();
  }
 }
 public void testRegularQueuedFramesCannotCrossVisibilityGenerationApprovalOrConnection() throws Exception { staleQueuedFrames(false); }
 public void testExtensionQueuedFramesCannotCrossVisibilityGenerationGrantOrConnection() throws Exception { staleQueuedFrames(true); }

 public void testAuditOfflineRevocationImmediatelyClearsEffectiveOverride() throws Exception {
  String c=approve("CanvasService"); send(c,"test-publish-extensions",declarations("ui.typography","{\"size\":17}")); settle(); grantExtension(c,"ui.typography",true);
  java.lang.reflect.Method disconnect=FaceclawExternalApps.class.getDeclaredMethod("disconnect",String.class,boolean.class); disconnect.setAccessible(true);
  runOnMainSync(()->{try{disconnect.invoke(manager,c,false);}catch(Exception e){throw new RuntimeException(e);}});
  assertFalse(manager.isConnected(c));
  assertEquals(c,auditOwner("ui.typography"));
  revokeThroughPolicy(c);
  assertFalse(context.getSharedPreferences("faceclaw-external-apps",0).contains(c+":pin"));
  assertEquals("",auditOwner("ui.typography"));
 }
 public void testAuditUnchangedRefreshPreservesPendingProviderRequest() throws Exception {
  String c=approve("CanvasService"); send(c,"test-publish-extensions",declarations("assistant","{}")); settle(); grantExtension(c,"assistant",true);
  java.lang.reflect.Field connections=FaceclawExternalApps.class.getDeclaredField("connections"); connections.setAccessible(true);
  AtomicReference<Throwable> failure=new AtomicReference<>();
  runOnMainSync(()->{try {
   Object connection=((java.util.Map<?,?>)connections.get(manager)).get(c);
   java.lang.reflect.Field field=connection.getClass().getDeclaredField("extensionRequests");field.setAccessible(true);
   java.util.Map<?,?> pending=(java.util.Map<?,?>)field.get(connection);
   assertTrue("Request admitted",manager.sendExtension(c,"assistant","request","{\"requestId\":\"audit-inflight\"}"));
   assertTrue("Request pending before refresh",pending.containsKey("audit-inflight"));
   manager.refresh();
   assertTrue("Same winner remains connected",manager.isConnected(c));
   assertTrue("Unchanged refresh must preserve pending request",pending.containsKey("audit-inflight"));
  }catch(Throwable e){failure.set(e);}});
  if(failure.get()!=null) throw new AssertionError(failure.get());
 }

 private String auditOwner(String feature) throws Exception {
  org.json.JSONArray entries=new org.json.JSONObject(manager.extensionsJson()).getJSONArray("features");
  for(int i=0;i<entries.length();i++)if(feature.equals(entries.getJSONObject(i).getString("feature")))return entries.getJSONObject(i).getString("component");
  throw new AssertionError("Feature absent");
 }

 private static final String DEMO_A="com.faceclaw.demo.a/com.faceclaw.demo.DemoService",DEMO_B="com.faceclaw.demo.b/com.faceclaw.demo.DemoService";
 private interface Checked { void run() throws Exception; }
 private void checkedMain(Checked action) throws Exception {
  AtomicReference<Throwable> error=new AtomicReference<>();
  runOnMainSync(()->{try{action.run();}catch(Throwable failure){error.set(failure);}});
  if(error.get()!=null)throw new AssertionError(error.get());
 }
 private void clearDemoGrants() throws Exception {
  checkedMain(()->{
   android.content.SharedPreferences prefs=context.getSharedPreferences("faceclaw-external-apps",0);
   android.content.SharedPreferences.Editor edit=prefs.edit();
   for(String key:prefs.getAll().keySet())if(key.startsWith("com.faceclaw.demo.a/")||key.startsWith("com.faceclaw.demo.b/"))edit.remove(key);
   edit.commit();manager.refresh();
  });
 }
 private void setupDemos() throws Exception {
  assertEquals("com.faceclaw.sdk.hosttest",context.getPackageName());
  assertTrue("Demos must be separate Android UIDs",context.getPackageManager().getApplicationInfo("com.faceclaw.demo.a",0).uid!=context.getPackageManager().getApplicationInfo("com.faceclaw.demo.b",0).uid);
  clearDemoGrants();
  checkedMain(()->{
   android.content.SharedPreferences.Editor edit=context.getSharedPreferences("faceclaw-external-apps",0).edit();
   for(String component:new String[]{DEMO_A,DEMO_B})edit.putString(component+":pin",PackageIdentity.forPackage(context,component.split("/",2)[0]));
   edit.commit();manager.refresh();
  });
  long deadline=android.os.SystemClock.elapsedRealtime()+5000;
  while(android.os.SystemClock.elapsedRealtime()<deadline&&(!manager.isConnected(DEMO_A)||!manager.isConnected(DEMO_B)))settle();
  assertTrue("Prepare both demo test APKs with DemoSetup before this suite",manager.isConnected(DEMO_A)&&manager.isConnected(DEMO_B));settle();
  for(String component:new String[]{DEMO_A,DEMO_B})for(String feature:new String[]{"ui.typography","ui.navigation","ui.window-layout","ui.launcher","assistant"})grantExtension(component,feature,true);
 }
 private org.json.JSONObject demoFeature(String name) throws Exception {
  org.json.JSONArray features=new org.json.JSONObject(manager.extensionsJson()).getJSONArray("features");
  for(int i=0;i<features.length();i++)if(name.equals(features.getJSONObject(i).getString("feature")))return features.getJSONObject(i);
  throw new AssertionError("Missing feature: "+name);
 }
 private void priority(String feature,String component) throws Exception { checkedMain(()->assertTrue("Priority accepted",manager.prioritizeExtension(feature,component))); }
 private void disconnectDemo(String component) throws Exception {
  java.lang.reflect.Method method=FaceclawExternalApps.class.getDeclaredMethod("disconnect",String.class,boolean.class);method.setAccessible(true);
  checkedMain(()->method.invoke(manager,component,false));
 }
 public void testDemoIndependentPrioritiesAndOfflineRevocation() throws Exception {
  setupDemos();priority("ui.typography",DEMO_B);priority("assistant",DEMO_B);
  assertEquals(DEMO_B,auditOwner("ui.typography"));assertEquals(14,demoFeature("ui.typography").getJSONObject("configuration").getInt("size"));
  priority("ui.typography",DEMO_A);priority("assistant",DEMO_A);
  assertEquals(DEMO_A,auditOwner("ui.typography"));assertEquals(18,demoFeature("ui.typography").getJSONObject("configuration").getInt("size"));
  disconnectDemo(DEMO_A);
  assertEquals(DEMO_A,auditOwner("ui.typography"));assertTrue("Static configuration persists",demoFeature("ui.typography").getBoolean("available"));
  assertEquals(DEMO_A,auditOwner("assistant"));assertFalse(demoFeature("assistant").getBoolean("available"));
  revokeThroughPolicy(DEMO_A);
  assertEquals(DEMO_B,auditOwner("ui.typography"));assertEquals(DEMO_B,auditOwner("assistant"));
  assertTrue("Next live provider available",demoFeature("assistant").getBoolean("available"));
  checkedMain(()->assertTrue("B accepts new requests",manager.sendExtension(DEMO_B,"assistant","request","{\"requestId\":\"demo-b-response\",\"text\":\"synthetic\"}")));
  settle();assertEquals(1,extensionResults.get());assertTrue("B supplied the response",extensionResultPayload.contains("Demo B"));
  revokeThroughPolicy(DEMO_B);assertEquals("",auditOwner("ui.typography"));assertFalse(demoFeature("ui.typography").getBoolean("available"));
 }
 public void testDemoLowerPriorityChangesPreserveWinnerRequestsAndFrames() throws Exception {
  setupDemos();priority("assistant",DEMO_A);priority("ui.launcher",DEMO_A);priority("ui.navigation",DEMO_A);
  checkedMain(()->{assertTrue("Open A surface",manager.openExtensionSurface(DEMO_A,"ui.launcher",576,260));manager.setExtensionSurfaceVisibility(DEMO_A,"ui.launcher",true,true);});
  settle();assertTrue("A rendered",extensionFrames.get()>0);int before=extensionFrames.get();
  long epoch=demoFeature("assistant").getLong("generation"),surfaceEpoch=demoFeature("ui.launcher").getLong("generation");
  checkedMain(()->{
   assertTrue("A request dispatched",manager.sendExtension(DEMO_A,"assistant","request","{\"requestId\":\"winner-inflight\",\"text\":\"synthetic\"}"));
   context.getSharedPreferences("faceclaw-external-apps",0).edit().putBoolean(DEMO_B+":extension:ui.navigation",false).commit();manager.refresh();
   manager.setExtensionSurfaceVisibility(DEMO_A,"ui.launcher",true,true);
  });
  settle();assertEquals(epoch,demoFeature("assistant").getLong("generation"));assertEquals(surfaceEpoch,demoFeature("ui.launcher").getLong("generation"));
  assertEquals(1,extensionResults.get());assertTrue("A response survived unrelated change",extensionResultPayload.contains("Demo A"));
  assertTrue("SDK retained A surface across the snapshot",extensionFrames.get()>before);
  disconnectDemo(DEMO_B);assertEquals(epoch,demoFeature("assistant").getLong("generation"));
 }
 public void testDemoFeatureGrantsAreIndependentAndReconnectKeepsOrder() throws Exception {
  setupDemos();priority("ui.typography",DEMO_A);priority("ui.navigation",DEMO_B);priority("assistant",DEMO_A);
  assertEquals(DEMO_A,auditOwner("ui.typography"));assertEquals(DEMO_B,auditOwner("ui.navigation"));
  grantExtension(DEMO_A,"ui.typography",false);assertEquals(DEMO_B,auditOwner("ui.typography"));assertEquals(DEMO_A,auditOwner("assistant"));
  disconnectDemo(DEMO_A);assertFalse(demoFeature("assistant").getBoolean("available"));
  checkedMain(()->manager.refresh());long deadline=android.os.SystemClock.elapsedRealtime()+5000;
  while(!manager.isConnected(DEMO_A)&&android.os.SystemClock.elapsedRealtime()<deadline)settle();
  assertTrue("A reconnected",manager.isConnected(DEMO_A));assertEquals(DEMO_A,auditOwner("assistant"));assertTrue("A live again",demoFeature("assistant").getBoolean("available"));
  assertEquals(DEMO_B,auditOwner("ui.typography"));
 }
 public void testDemoLauncherInputSuppliesBoundedActionIdentity() throws Exception {
  setupDemos();priority("ui.launcher",DEMO_A);
  checkedMain(()->{
   assertTrue("Open launcher",manager.openExtensionSurface(DEMO_A,"ui.launcher",576,260));
   manager.setExtensionSurfaceVisibility(DEMO_A,"ui.launcher",true,true);
   manager.sendExtension(DEMO_A,"ui.launcher","event","{\"event\":\"host-state\",\"apps\":[{\"appId\":\"synthetic-app\",\"title\":\"Synthetic app\"}]}");
  });settle();
  checkedMain(()->assertTrue("Header input delivered",manager.sendExtensionPointer(DEMO_A,"ui.launcher",20,20,576,260)));settle();assertEquals(null,extensionActionPayload);
  checkedMain(()->assertTrue("Row input delivered",manager.sendExtensionPointer(DEMO_A,"ui.launcher",20,70,576,260)));settle();
  assertTrue("Semantic action received",extensionActionPayload!=null);
  org.json.JSONObject action=new org.json.JSONObject(extensionActionPayload);assertEquals("open-app",action.getString("action"));
  assertEquals("synthetic-app",action.getJSONObject("data").getString("appId"));
  assertTrue("Host action adapter requires callId",ExtensionContract.token(action.getJSONObject("data").getString("callId")));
 }
 private void configureDemoA(String option,String value) throws Exception {
  if(!java.util.Arrays.asList("enabled","withdraw","dependency").contains(option)||!java.util.Arrays.asList("true","false").contains(value))throw new IllegalArgumentException();
  // Shell-installed test instrumentation is separate from the ordinary demo APK.
  String command="am instrument -w -e "+option+" "+value+" com.faceclaw.demo.a.test/com.faceclaw.demo.DemoSetup";
  try(android.os.ParcelFileDescriptor descriptor=getUiAutomation().executeShellCommand(command);
      java.io.InputStream stream=new java.io.FileInputStream(descriptor.getFileDescriptor());
      java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream()) {
   byte[] block=new byte[1024];int count;
   while((count=stream.read(block))!=-1) {output.write(block,0,count);if(output.size()>32768)throw new AssertionError("Unbounded instrumentation output");}
   assertTrue("Demo settings instrumentation failed: "+output,output.toString("UTF-8").contains("Prepared com.faceclaw.demo.a"));
  }
  checkedMain(()->manager.refresh());long deadline=android.os.SystemClock.elapsedRealtime()+6000;
  while(!manager.isConnected(DEMO_A)&&android.os.SystemClock.elapsedRealtime()<deadline)settle();
  assertTrue("A returned after app-side settings change",manager.isConnected(DEMO_A));settle();
 }
 public void testDemoAppSideDisableAndWithdrawalReachTheHost() throws Exception {
  setupDemos();priority("ui.typography",DEMO_A);assertEquals(DEMO_A,auditOwner("ui.typography"));
  configureDemoA("enabled","false");assertEquals(DEMO_B,auditOwner("ui.typography"));
  configureDemoA("withdraw","true");assertEquals(DEMO_B,auditOwner("ui.typography"));
  org.json.JSONArray contenders=demoFeature("ui.typography").getJSONArray("contenders");
  for(int i=0;i<contenders.length();i++)assertFalse(DEMO_A.equals(contenders.getJSONObject(i).getString("component")));
  configureDemoA("enabled","true");assertEquals(DEMO_A,auditOwner("ui.typography"));
 }
 public void testDemoDependencyControlsEligibilityAndOfflineAvailability() throws Exception {
  setupDemos();priority("ui.typography",DEMO_A);priority("ui.launcher",DEMO_B);
  configureDemoA("dependency","true");assertEquals(DEMO_B,auditOwner("ui.typography"));
  priority("ui.launcher",DEMO_A);assertEquals(DEMO_A,auditOwner("ui.typography"));
  long epoch=demoFeature("ui.typography").getLong("generation");
  disconnectDemo(DEMO_A);
  assertEquals(DEMO_A,auditOwner("ui.typography"));assertFalse(demoFeature("ui.typography").getBoolean("available"));
  assertTrue("Dependent epoch follows live availability",demoFeature("ui.typography").getLong("generation")>epoch);
  configureDemoA("dependency","false");assertEquals(DEMO_A,auditOwner("ui.typography"));assertTrue("Independent static feature restored",demoFeature("ui.typography").getBoolean("available"));
 }
 public void testDemoLateReplyCannotCrossOwnerChange() throws Exception {
  setupDemos();priority("assistant",DEMO_A);
  checkedMain(()->assertTrue("Delayed request accepted",manager.sendExtension(DEMO_A,"assistant","request","{\"requestId\":\"stale-demo-response\",\"text\":\"synthetic\"}")));
  settle();priority("assistant",DEMO_B);
  // Run this case with Demo A configured through DemoSetup -e mode late.
  Thread.sleep(16000);waitForIdleSync();assertEquals(0,extensionResults.get());
  checkedMain(()->assertTrue("B handles only a new explicit request",manager.sendExtension(DEMO_B,"assistant","request","{\"requestId\":\"fresh-demo-response\",\"text\":\"synthetic\"}")));
  settle();assertEquals(1,extensionResults.get());assertTrue("Only B response admitted",extensionResultPayload.contains("Demo B"));
 }
}
