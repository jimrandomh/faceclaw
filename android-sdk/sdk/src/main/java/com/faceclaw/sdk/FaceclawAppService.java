package com.faceclaw.sdk;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.os.*;
import android.system.OsConstants;
import org.json.JSONObject;
import org.json.JSONArray;
import java.nio.ByteBuffer;
import java.util.UUID;

/** App-owned service. All callbacks run on the main looper. The host never loads app code. */
public abstract class FaceclawAppService extends Service {
 static FaceclawAppService active;
 private final Handler handler=new Handler(Looper.getMainLooper());
 private final Messenger incoming=new Messenger(new Handler(Looper.getMainLooper(),m->{ receive(m); return true; }));
 private Messenger host, pendingHost;
 private android.content.SharedPreferences approvals;
 private String hostIdentity="", session="", pendingToken="", pendingPin="", pendingSession="";
 private long pendingUntil, sequence, inFlight, generation;
 private int width,height; private boolean visible,screenOn=true;
 private byte[] latestPixels;
 private IBinder.DeathRecipient death;
 private static final class ExtensionSurface {
  int width,height; long generation,sequence,inFlight; boolean visible,screenOn; byte[] pending;
 }
 private final java.util.Map<String,ExtensionSurface> extensionSurfaces=new java.util.HashMap<>();
 private JSONObject extensionSnapshot=new JSONObject(),sharedStyle=new JSONObject();
 public final JSONObject sharedStyle() { try { return new JSONObject(sharedStyle.toString()); } catch(Exception ignored) { return new JSONObject(); } }
 public final JSONObject extensions() { try { return new JSONObject(extensionSnapshot.toString()); } catch(Exception ignored) { return new JSONObject(); } }
 public final boolean publishExtensions(org.json.JSONArray declarations) {
  try { return send("publish-extensions",Protocol.object("declarations",ExtensionContract.declarations(declarations))); } catch(Exception ignored) { return false; }
 }
 public final boolean respondExtension(String feature,long generation,String requestId,JSONObject data) {
  if(!ExtensionContract.known(feature)||!ExtensionContract.token(requestId)||data==null||data.toString().length()>Protocol.MAX_JSON/2) return false;
  return send("extension-result",Protocol.object("feature",feature,"generation",generation,"requestId",requestId,"data",data));
 }
 public final boolean reportExtensionProgress(String feature,long generation,String requestId,JSONObject data) {
  if(!ExtensionContract.known(feature)||!ExtensionContract.token(requestId)||data==null||data.toString().length()>Protocol.MAX_JSON/2) return false;
  return send("extension-progress",Protocol.object("feature",feature,"generation",generation,"requestId",requestId,"data",data));
 }
 public final boolean invokeExtensionAction(String feature,long generation,String action,JSONObject data) {
  if(!ExtensionContract.action(feature,action)||data==null||data.toString().length()>Protocol.MAX_JSON/2) return false;
  return send("extension-action",Protocol.object("feature",feature,"generation",generation,"action",action,"actionId",UUID.randomUUID().toString(),"data",data));
 }
 private void extensionSurface(JSONObject data) throws Exception {
  String feature=data.getString("feature"),type=data.getString("type"); if(!ExtensionContract.surface(feature)) throw new IllegalArgumentException("Unknown surface");
  if(type.equals("open")||type.equals("resize")) {
   ExtensionSurface surface=new ExtensionSurface(); surface.width=data.getInt("width"); surface.height=data.getInt("height"); Protocol.frameSize(surface.width,surface.height); surface.generation=data.getLong("generation"); extensionSurfaces.put(feature,surface);
  } else {
   ExtensionSurface surface=extensionSurfaces.get(feature); if(surface==null||surface.generation!=data.getLong("generation")) return;
   if(type.equals("close")) extensionSurfaces.remove(feature);
   else if(type.equals("visibility")) { surface.visible=Boolean.TRUE.equals(data.opt("visible")); surface.screenOn=Boolean.TRUE.equals(data.opt("screenOn")); if(!surface.visible||!surface.screenOn) surface.pending=null; }
  }
 }
 public final void submitExtensionBitmap(String feature,Bitmap bitmap) {
  if(Looper.myLooper()!=Looper.getMainLooper()) throw new IllegalStateException("Submit on main thread");
  ExtensionSurface surface=extensionSurfaces.get(feature);
  if(host==null||surface==null||!surface.visible||!surface.screenOn||bitmap==null||bitmap.getWidth()!=surface.width||bitmap.getHeight()!=surface.height) return;
  int count=Protocol.frameSize(surface.width,surface.height); int[] argb=new int[count]; bitmap.getPixels(argb,0,surface.width,0,0,surface.width,surface.height); byte[] pixels=new byte[count];
  for(int i=0;i<count;i++) { int c=argb[i],alpha=c>>>24,luminance=(((c>>16)&255)*54+((c>>8)&255)*183+(c&255)*19)>>8; pixels[i]=alpha==0?0:(byte)Math.max(1,luminance*alpha/255); }
  surface.pending=pixels; flushExtensionFrame(feature,surface);
 }
 private void flushExtensionFrame(String feature,ExtensionSurface surface) {
  if(host==null||surface.inFlight!=0||surface.pending==null) return;
  byte[] pixels=surface.pending; surface.pending=null;
  Message message=Protocol.message(Protocol.EXTENSION_FRAME,session,"frame",null); Bundle b=message.getData(); b.putString("feature",feature); b.putLong("generation",surface.generation); b.putInt("width",surface.width); b.putInt("height",surface.height); b.putLong("sequence",++surface.sequence); surface.inFlight=surface.sequence;
  try {
   if(Build.VERSION.SDK_INT>=27) {
    SharedMemory memory=SharedMemory.create("faceclaw-extension-frame",pixels.length);
    try { ByteBuffer mapping=memory.mapReadWrite(); mapping.put(pixels); SharedMemory.unmap(mapping); if(!memory.setProtect(OsConstants.PROT_READ)) throw new IllegalStateException("Frame seal failed"); b.putParcelable("memory",memory); host.send(message); } finally { memory.close(); }
   } else { b.putByteArray("pixels",pixels); host.send(message); }
  } catch(Exception ignored) { disconnect(); }
 }
 private boolean notificationReplyAllowed;
 private final NotificationReplies notificationReplies=new NotificationReplies();
 @Override public void onCreate() { super.onCreate(); approvals=ApprovalStore.open(this,"faceclaw-host"); active=this; }
 @Override public IBinder onBind(Intent intent) { return incoming.getBinder(); }
 @Override public void onDestroy() { disconnect(); if(active==this) active=null; super.onDestroy(); }
 protected void onHostConnected() {}
 protected void onHostDisconnected() {}
 protected abstract void onHostEvent(String type,JSONObject data);
 public final String selectedHostPackage() {
  String pin=approvals.getString("identity","");
  return pin.isEmpty()?"":PackageIdentity.packageName(pin);
 }
 public final boolean selectedHostIsInstalled() {
  String pin=approvals.getString("identity","");
  try { return !pin.isEmpty() && pin.equals(PackageIdentity.forPackage(this,PackageIdentity.packageName(pin))); }
  catch(Exception ignored) { return false; }
 }
 public final String selectedHostLabel() {
  if(!selectedHostIsInstalled()) return "";
  try { return getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(selectedHostPackage(),0)).toString(); }
  catch(Exception ignored) { return ""; }
 }
 private void receive(Message m) {
  try {
   String identity=PackageIdentity.forUid(this,m.sendingUid);
   Bundle b=m.getData(); String suppliedSession=b.getString("session","");
   if(m.what==Protocol.HELLO) {
    if(m.replyTo==null || Protocol.json(b).optInt("version")!=Protocol.VERSION || suppliedSession.length()<20 || suppliedSession.length()>80) return;
    String pin=approvals.getString("identity","");
    if(!identity.equals(pin)) {
     // An unselected host cannot displace a selected connection without a user gesture.
     if(SystemClock.elapsedRealtime()<pendingUntil && !identity.equals(pendingPin)) return;
     pendingPin=identity; pendingSession=suppliedSession; pendingHost=m.replyTo;
     pendingToken=UUID.randomUUID().toString(); pendingUntil=SystemClock.elapsedRealtime()+120000;
     Intent intent=new Intent(this,HostApprovalActivity.class).putExtra("token",pendingToken).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
     PendingIntent consent=PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
     Message reply=Protocol.message(Protocol.CONSENT,suppliedSession,"consent",null); reply.getData().putParcelable("consent",consent); m.replyTo.send(reply); return;
    }
    connect(m.replyTo,identity,suppliedSession); return;
   }
   if(host==null || !identity.equals(hostIdentity) || !session.equals(suppliedSession)) return;
   if(m.what==Protocol.EXTENSION_ACK) {
    String feature=b.getString("feature",""); ExtensionSurface surface=extensionSurfaces.get(feature);
    if(surface!=null&&surface.generation==b.getLong("generation")&&surface.inFlight==b.getLong("sequence")) { surface.inFlight=0; flushExtensionFrame(feature,surface); } return;
   }
   if(m.what==Protocol.ACK) { if(b.getLong("sequence")==inFlight) { inFlight=0; flushFrame(); } return; }
   if(m.what!=Protocol.EVENT) return;
   String type=b.getString("type",""); JSONObject data=Protocol.json(b);
   if(type.equals("shared-style")) { sharedStyle=ExtensionContract.configuration("ui.typography",data); Ui.applySharedStyle(this,sharedStyle); }
   if(type.equals("extensions")) {
    JSONObject next=new JSONObject(data.toString());
    java.util.Map<String,ExtensionSurface> closed=new java.util.HashMap<>();
    for(java.util.Map.Entry<String,ExtensionSurface> entry:extensionSurfaces.entrySet())if(!sameFeature(extensionSnapshot,next,entry.getKey()))closed.put(entry.getKey(),entry.getValue());
    for(String feature:closed.keySet())extensionSurfaces.remove(feature);
    extensionSnapshot=next;
    for(java.util.Map.Entry<String,ExtensionSurface> entry:closed.entrySet())onHostEvent("extension-surface",Protocol.object("feature",entry.getKey(),"type","close","generation",entry.getValue().generation));
   }
   if(type.equals("extension-surface")) extensionSurface(data);
   if(type.equals("revoke")) { disconnect(); return; }
   if(type.equals("open") || type.equals("resize")) {
    int w=data.getInt("width"), h=data.getInt("height"); Protocol.frameSize(w,h);
    width=w; height=h; generation=data.getLong("generation"); latestPixels=null; inFlight=0;
   }
   if(type.equals("close")) { width=height=0; visible=false; latestPixels=null; inFlight=0; }
   if(type.equals("visibility")) { visible=data.optBoolean("visible"); screenOn=data.optBoolean("screenOn"); if(!visible||!screenOn) latestPixels=null; }
   if(type.equals("capabilities")) {
    notificationReplyAllowed=Boolean.TRUE.equals(data.opt("notifications"))&&Boolean.TRUE.equals(data.opt("dictation"))&&Boolean.TRUE.equals(data.opt("notificationReplies"));
    if(!notificationReplyAllowed) notificationReplies.clear();
   }
   if(type.equals("notification-reply")) {
    if(!notificationReplyAllowed || !Boolean.TRUE.equals(data.opt("confirmed")) || !(data.opt("id") instanceof String) || !(data.opt("target") instanceof String) || !(data.opt("replyToken") instanceof String) || !(data.opt("text") instanceof String) || data.getString("text").trim().isEmpty() || data.getString("text").length()>8000 ||
      !notificationReplies.consume(data.optString("id"),data.optString("target"),data.optString("replyToken"),System.currentTimeMillis())) return;
   }
   onHostEvent(type,data);
  } catch(Exception ignored) { /* Malformed or unauthorized IPC never reaches app callbacks. */ }
 }
 String pendingIdentity(String token) {
  return token!=null && token.equals(pendingToken) && SystemClock.elapsedRealtime()<pendingUntil?pendingPin:null;
 }
 private static boolean sameFeature(JSONObject before,JSONObject after,String feature) {
  JSONObject previous=featureState(before,feature),next=featureState(after,feature);
  return previous!=null&&next!=null&&previous.optLong("generation",-1)==next.optLong("generation",-2)
   &&previous.optString("component").equals(next.optString("component"))&&next.optBoolean("available");
 }
 private static JSONObject featureState(JSONObject snapshot,String feature) {
  JSONArray values=snapshot.optJSONArray("features");
  if(values!=null)for(int i=0;i<values.length();i++) { JSONObject value=values.optJSONObject(i); if(value!=null&&feature.equals(value.optString("feature")))return value; }
  return null;
 }
 void approveHost(String token) {
  try {
   if(pendingIdentity(token)==null || !PackageIdentity.forPackage(this,PackageIdentity.packageName(pendingPin)).equals(pendingPin)) return;
   String pin=pendingPin,s=pendingSession; Messenger remote=pendingHost;
   pendingUntil=0; pendingToken=""; pendingHost=null;
   approvals.edit().putString("identity",pin).commit();
   connect(remote,pin,s);
  } catch(Exception ignored) {}
 }
 private void connect(Messenger remote,String identity,String newSession) throws RemoteException {
  if(host!=null && !hostIdentity.equals(identity)) {
   try { host.send(Protocol.message(Protocol.EVENT,session,"host-switched",null)); } catch(Exception ignored) {}
  }
  disconnect(); host=remote; hostIdentity=identity; session=newSession; sequence=0;
  final String connectedSession=session;
  death=()->handler.post(()->{ if(session.equals(connectedSession)) disconnect(); });
  host.getBinder().linkToDeath(death,0);
  host.send(Protocol.message(Protocol.READY,session,"ready",Protocol.object("version",Protocol.VERSION)));
  onHostConnected();
 }
 private void disconnect() {
  extensionSurfaces.clear(); extensionSnapshot=new JSONObject(); sharedStyle=new JSONObject(); Ui.resetSharedStyle();
  notificationReplyAllowed=false; notificationReplies.clear();
  if(host!=null) {
   try { host.send(Protocol.message(Protocol.EVENT,session,"disconnected",null)); } catch(Exception ignored) {}
   if(death!=null) host.getBinder().unlinkToDeath(death,0);
   host=null; hostIdentity=""; session=""; width=height=0; visible=false; inFlight=0; latestPixels=null;
   onHostDisconnected();
  }
 }
 /** Coalesces to one pending frame plus one IPC frame, preventing animation queue growth. */
 public final void submitBitmap(Bitmap bitmap) {
  if(Looper.myLooper()!=Looper.getMainLooper()) throw new IllegalStateException("Submit on main thread");
  if(host==null || !visible || !screenOn || bitmap.getWidth()!=width || bitmap.getHeight()!=height) return;
  int count=Protocol.frameSize(width,height); int[] argb=new int[count]; bitmap.getPixels(argb,0,width,0,0,width,height);
  byte[] pixels=new byte[count];
  for(int i=0;i<count;i++) {
   int c=argb[i], alpha=c>>>24; int luminance=(((c>>16)&255)*54+((c>>8)&255)*183+(c&255)*19)>>8;
   // Final app frame is opaque; Canvas layers resolve alpha against black first.
   pixels[i]=(byte)Math.max(1,luminance*alpha/255);
  }
  latestPixels=pixels; flushFrame();
 }
 private void flushFrame() {
  if(host==null || inFlight!=0 || latestPixels==null) return;
  byte[] pixels=latestPixels; latestPixels=null;
  Message m=Protocol.message(Protocol.FRAME,session,"frame",null); Bundle b=m.getData();
  b.putLong("generation",generation); b.putInt("width",width); b.putInt("height",height); b.putLong("sequence",++sequence); inFlight=sequence;
  try {
   if(Build.VERSION.SDK_INT>=27) {
    SharedMemory memory=SharedMemory.create("faceclaw-frame",pixels.length);
    try {
     ByteBuffer mapping=memory.mapReadWrite(); mapping.put(pixels); SharedMemory.unmap(mapping);
     if(!memory.setProtect(OsConstants.PROT_READ)) throw new IllegalStateException("Frame seal failed");
     b.putParcelable("memory",memory); host.send(m);
    } finally { memory.close(); }
   } else { b.putByteArray("pixels",pixels); host.send(m); }
  } catch(Exception ignored) { disconnect(); }
 }
 private boolean send(String type,JSONObject data) {
  if(data.toString().length()>Protocol.MAX_JSON) return false;
  final Messenger destination=host; final String sendingSession=session;
  if(destination==null) return false;
  handler.post(()->{
   if(host!=destination || !session.equals(sendingSession)) return;
   try { destination.send(Protocol.message(Protocol.EVENT,sendingSession,type,data)); } catch(Exception ignored) { disconnect(); }
  });
  return true;
 }
 public final void postNotification(String id,String target,String title,String text,long expiresAtMs) {
  postNotification(id,target,title,text,expiresAtMs,"");
 }
 /** A fresh opaque token binds one explicit host-reviewed reply to this publication. */
 public final void postNotification(String id,String target,String title,String text,long expiresAtMs,String replyToken) {
  if(id==null||id.isEmpty()||id.length()>128||target==null||target.isEmpty()||target.length()>512||title==null||title.length()>160||text==null||text.length()>4096||replyToken==null||replyToken.length()>128) return;
  notificationReplies.publish(id,target,replyToken,expiresAtMs,System.currentTimeMillis());
  send("notification",Protocol.object("id",id,"target",target,"title",title,"text",text,"expiresAt",expiresAtMs,"replyToken",replyToken));
 }
 public final void removeNotification(String id) { notificationReplies.remove(id); send("remove-notification",Protocol.object("id",id)); }
 /** Report one bounded, content-free outcome for a consumed action in this session. */
 public final void reportNotificationReplyResult(String id,String replyToken,String status) {
  if(status!=null&&notificationReplies.report(id,replyToken,status,System.currentTimeMillis()))
   send("notification-reply-result",Protocol.object("id",id,"replyToken",replyToken,"status",status));
 }
 public final boolean requestDictation(String requestId,String target,String label) {
  return requestDictation(requestId,target,label,"");
 }
 public final boolean requestDictation(String requestId,String target,String label,String initialText) {
  if(initialText==null || initialText.length()>8000 || host==null) return false;
  return send("dictation",Protocol.object("requestId",requestId,"target",target,"label",label,"initialText",initialText));
 }
 /** Search confirmation is a distinct protocol purpose, never a message-send review. */
 public final boolean requestSearchDictation(String requestId,String target,String label) {
  if(requestId==null||requestId.isEmpty()||requestId.length()>128||target==null||target.isEmpty()||target.length()>512||label==null||label.length()>100||host==null) return false;
  return send("search-dictation",Protocol.object("requestId",requestId,"target",target,"label",label));
 }
 public final void cancelSearchDictation(String requestId) { send("cancel-search-dictation",Protocol.object("requestId",requestId)); }
 public final boolean requestCaptureDictation(String requestId,String label) {
  if(!ExtensionContract.token(requestId)||label==null||label.length()>100) return false;
  return requestCaptureDictation(requestId,label,false);
 }
 public final boolean requestCaptureDictation(String requestId,String label,boolean ownTranscription) {
  if(!ExtensionContract.token(requestId)||label==null||label.length()>100) return false;
  return send("capture-dictation",Protocol.object("requestId",requestId,"label",label,"ownTranscription",ownTranscription));
 }
 public final void finishCaptureDictation(String requestId) { if(ExtensionContract.token(requestId)) send("finish-capture-dictation",Protocol.object("requestId",requestId)); }
 public final void cancelCaptureDictation(String requestId) { if(ExtensionContract.token(requestId)) send("cancel-capture-dictation",Protocol.object("requestId",requestId)); }
 /** Explicit own-editor fallback; host retains its key and requires dictation consent and user action. */
 public final boolean requestHostRefinement(String requestId,String original,String followup) {
  if(!ExtensionContract.token(requestId)||original==null||original.length()>8000||followup==null||followup.trim().isEmpty()||followup.length()>8000) return false;
  return send("host-refinement",Protocol.object("requestId",requestId,"original",original,"followup",followup));
 }
 public final void cancelHostRefinement(String requestId) { if(ExtensionContract.token(requestId)) send("cancel-host-refinement",Protocol.object("requestId",requestId)); }
 public final boolean setWindowMenuAvailable(boolean available) { return send("window-menu-state",Protocol.object("available",available)); }
 public final boolean setWindowProtected(boolean protectedState) { return send("window-protection",Protocol.object("protected",protectedState)); }
 /** Focus this approved app's own host window while the unlocked display is already active. */
 public final boolean requestOwnNotifications() { return send("own-notifications",new JSONObject()); }
 public final boolean invokeOwnNotification(String action,String key,long postTime,String callId) {
  if(!java.util.Arrays.asList("open","dismiss").contains(action)||key==null||key.length()>512||!ExtensionContract.token(callId)||postTime<0) return false;
  return send("own-notification-action",Protocol.object("action",action,"key",key,"postTime",postTime,"callId",callId));
 }
 public final boolean dismissOwnNotificationGroup(JSONArray items,String callId) {
  if(items==null||items.length()<1||items.length()>50||items.toString().length()>16000||!ExtensionContract.token(callId)) return false;
  return send("own-notification-action",Protocol.object("action","dismiss-group","items",items,"callId",callId));
 }
 public final boolean requestOpenWindow() { return requestOpenWindow(""); }
 public final boolean requestOpenWindow(String target) {
  if(target==null||target.length()>512) return false;
  return send("request-open-window",Protocol.object("target",target));
 }
 public final boolean requestSleep() { return send("sleep",new JSONObject()); }
 /** Ask the host to show its system menu for this app's foreground window after a user gesture. */
 public final boolean requestSystemMenu() { return send("request-system-menu",new JSONObject()); }
 public final void cancelDictation(String requestId) { send("cancel-dictation",Protocol.object("requestId",requestId)); }
}
