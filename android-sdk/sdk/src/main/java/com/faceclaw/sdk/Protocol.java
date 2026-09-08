package com.faceclaw.sdk;

import android.os.*;
import org.json.JSONObject;
/** Version 1: one app window; grayscale8 pixels; all text/control payloads bounded. */
public final class Protocol {
 public static final String ACTION="com.faceclaw.action.APP_SERVICE";
 public static final int VERSION=1, HELLO=1, EVENT=2, FRAME=3, ACK=4, CONSENT=5, READY=6, EXTENSION_FRAME=7, EXTENSION_ACK=8;
 public static final int MAX_WIDTH=640, MAX_HEIGHT=480, MAX_JSON=65536;
 public static int frameSize(int width,int height) {
  if(width<1 || height<1 || width>MAX_WIDTH || height>MAX_HEIGHT) throw new IllegalArgumentException("Invalid viewport");
  return width*height;
 }
 public static JSONObject json(Bundle data) throws Exception {
  String text=data.getString("json","{}");
  if(text.length()>MAX_JSON) throw new IllegalArgumentException("Control message too large");
  return new JSONObject(text);
 }
 public static Message message(int kind,String session,String type,JSONObject json) {
  Message m=Message.obtain(null,kind); Bundle b=new Bundle();
  b.putString("session",session); b.putString("type",type);
  String text=json==null?"{}":json.toString();
  if(text.length()>MAX_JSON) throw new IllegalArgumentException("Control message too large");
  b.putString("json",text); m.setData(b); return m;
 }
 public static JSONObject object(Object... fields) {
  JSONObject result=new JSONObject();
  try { for(int i=0;i<fields.length;i+=2) result.put((String)fields[i],fields[i+1]); }
  catch(Exception e) { throw new IllegalArgumentException(e); }
  return result;
 }
 private Protocol() {}
}
