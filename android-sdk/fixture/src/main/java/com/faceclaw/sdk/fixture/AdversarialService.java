package com.faceclaw.sdk.fixture;
import android.app.Service;
import android.content.Intent;
import android.os.*;
import com.faceclaw.sdk.*;
import org.json.JSONObject;
/** Deliberately bypasses the SDK to exercise the host's trust boundary with malformed frames. */
public class AdversarialService extends Service {
 Messenger host; String session; long generation,sequence,extensionGeneration,extensionSequence; SharedMemory mutableFrame;
 private void sendColoredFrame(boolean extension,int color,boolean shared) throws Exception {
  Message frame=Protocol.message(extension?Protocol.EXTENSION_FRAME:Protocol.FRAME,session,"frame",null);
  Bundle data=frame.getData();data.putInt("width",32);data.putInt("height",16);data.putLong("generation",extension?extensionGeneration:generation);
  data.putLong("sequence",extension?++extensionSequence:++sequence);if(extension)data.putString("feature","ui.launcher");
  byte[] bytes=new byte[512];java.util.Arrays.fill(bytes,(byte)color);
  if(shared&&Build.VERSION.SDK_INT>=27) { mutableFrame=SharedMemory.create("synthetic-mutable-frame",512);java.nio.ByteBuffer mapping=mutableFrame.mapReadWrite();mapping.put(bytes);SharedMemory.unmap(mapping);data.putParcelable("memory",mutableFrame); }
  else data.putByteArray("pixels",bytes);
  host.send(frame);
 }
 final Messenger incoming=new Messenger(new Handler(Looper.getMainLooper(),m->{
  try {
   Bundle b=m.getData();
   if((m.what==Protocol.ACK||m.what==Protocol.EXTENSION_ACK)&&mutableFrame!=null) {
    java.nio.ByteBuffer mapping=mutableFrame.mapReadWrite();while(mapping.hasRemaining())mapping.put((byte)200);SharedMemory.unmap(mapping);mutableFrame.close();mutableFrame=null;
   }
   if(m.what==Protocol.HELLO) { host=m.replyTo; session=b.getString("session"); host.send(Protocol.message(Protocol.READY,session,"ready",Protocol.object("version",1))); }
   if(m.what==Protocol.EVENT) {
    String type=b.getString("type"); JSONObject data=Protocol.json(b);
    if(type.equals("open")||type.equals("resize")) generation=data.getLong("generation");
    if(type.equals("extension-surface")&&data.optString("type").equals("open")) extensionGeneration=data.getLong("generation");
    if(type.equals("fixture")) {
     String attack=data.getString("attack");
     if(attack.equals("frame-burst")||attack.equals("extension-burst")) { for(int i=1;i<=4;i++)sendColoredFrame(attack.startsWith("extension"),i,false); }
     else if(attack.equals("frame-memory")||attack.equals("extension-memory"))sendColoredFrame(attack.startsWith("extension"),7,true);
     else if(attack.equals("publish-launcher"))host.send(Protocol.message(Protocol.EVENT,session,"publish-extensions",Protocol.object("declarations",new org.json.JSONArray().put(Protocol.object("feature","ui.launcher","enabled",true,"configuration",new JSONObject())))));
     else if(attack.equals("disconnect"))host.send(Protocol.message(Protocol.EVENT,session,"disconnected",null));
     else if(attack.equals("notification")) { host.send(Protocol.message(Protocol.EVENT,session,"notification",Protocol.object("id","x","target","synthetic","title","Synthetic","text","Synthetic"))); }
     else if(attack.startsWith("system-menu")) { host.send(Protocol.message(Protocol.EVENT,attack.equals("system-menu-stale")?"wrong-session":session,"request-system-menu",Protocol.object("windowId","foreign-window","action","close"))); }
     else if(attack.equals("consent-broadcast")) {
      android.app.PendingIntent pi=android.app.PendingIntent.getBroadcast(this,0,new Intent("com.faceclaw.fixture.NO_ACTION").setPackage(getPackageName()),android.app.PendingIntent.FLAG_IMMUTABLE);
      Message consent=Protocol.message(Protocol.CONSENT,session,"consent",null); consent.getData().putParcelable("consent",pi); host.send(consent);
     }
     else {
      Message frame=Protocol.message(Protocol.FRAME,attack.equals("session")?"wrong-session":session,"frame",null);
      Bundle f=frame.getData(); f.putInt("width",32); f.putInt("height",16); f.putLong("generation",attack.equals("generation")?generation-1:generation); f.putLong("sequence",++sequence);
      f.putByteArray("pixels",new byte[attack.equals("length")?1:512]); host.send(frame);
     }
    }
   }
  } catch(Exception e) { throw new RuntimeException(e); }
  return true;
 }));
 @Override public IBinder onBind(Intent intent) { return incoming.getBinder(); }
}
