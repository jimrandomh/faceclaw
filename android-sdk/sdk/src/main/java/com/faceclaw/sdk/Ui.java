package com.faceclaw.sdk;

import android.graphics.*;
import android.content.Context;
import org.json.JSONObject;
import java.util.*;
/** Optional ordinary Canvas helpers. All coordinates are viewport pixels. */
public final class Ui {
 /** Immutable style shared by measurement and drawing in an app process. */
 public static final class Style {
  public final Typeface typeface;
  public final boolean antiAlias,hinted;
  public final float size;
  private final int border,selectionBorder,radius;
  private Style(Typeface face,boolean aa,boolean hint,float size,int border,int selectionBorder,int radius) {
   this.typeface=face; this.antiAlias=aa; this.hinted=hint; this.size=size;
   this.border=border; this.selectionBorder=selectionBorder; this.radius=radius;
  }
  /** Existing apps use 16px as their body role; relative sizes retain their hierarchy. */
  public float fontSize(float originalSize) { return originalSize*size/16f; }
  public float borderWidth(float originalWidth) { return border<0?originalWidth:border; }
  public float selectionBorderWidth(float originalWidth) { return selectionBorder<0?originalWidth:selectionBorder; }
  public float cornerRadius(float originalRadius) { return radius<0?originalRadius:radius; }
  public Paint textPaint(float originalSize,int color) {
   Paint paint=new Paint(); paint.setColor(color); paint.setTypeface(typeface); paint.setTextSize(fontSize(originalSize));
   paint.setAntiAlias(antiAlias); paint.setSubpixelText(false); paint.setHinting(hinted?Paint.HINTING_ON:Paint.HINTING_OFF);
   return paint;
  }
 }
 private static volatile Style shared=defaults();
 private static Style defaults() { return new Style(Typeface.create("sans-serif",Typeface.NORMAL),true,false,16f,-1,-1,-1); }
 public static Style style() { return shared; }
 public static void resetSharedStyle() { shared=defaults(); }
 /** Called by the verified SDK connection; font names refer only to SDK-bundled assets. */
 public static void applySharedStyle(Context context,JSONObject supplied) {
  try {
   JSONObject data=ExtensionContract.configuration("ui.typography",supplied);
   Typeface face=Typeface.create("sans-serif",Typeface.NORMAL);
   if(data.has("font")) face=Typeface.createFromAsset(context.getAssets(),"faceclaw/fonts/"+data.getString("font"));
   String raster=data.optString("raster","antialiased");
   shared=new Style(face,raster.equals("antialiased"),raster.equals("hinted"),(float)data.optDouble("size",16),
    data.optInt("borderWidth",-1),data.optInt("selectionBorderWidth",-1),data.optInt("cardRadius",-1));
  } catch(Exception unavailable) { resetSharedStyle(); }
 }
 public static void text(Canvas canvas,String text,float x,float baseline,float size,int color) {
  canvas.drawText(text,x,baseline,shared.textPaint(size,color));
 }
 public static void card(Canvas canvas,float left,float top,float right,float bottom,float radius,int color) {
  Style style=shared; Paint p=new Paint(); p.setAntiAlias(style.antiAlias); p.setColor(color);
  float effectiveRadius=style.cornerRadius(radius); canvas.drawRoundRect(left,top,right,bottom,effectiveRadius,effectiveRadius,p);
 }
 /** Body work is invoked only after the shared reveal threshold; draw at fixed destination coordinates. */
 public interface WindowBody { void draw(Canvas canvas); }
 public static void transitionCard(Canvas canvas, WindowMotion.Frame frame, String heading, WindowBody body) {
  WindowMotion.Rect r=frame.rect; float x=(float)r.x,y=(float)r.y,right=(float)(r.x+r.width),bottom=(float)(r.y+r.height);
  card(canvas,x,y,right,bottom,8,Color.BLACK);
  Paint border=new Paint();border.setAntiAlias(shared.antiAlias);border.setColor(Color.rgb(235,235,235));border.setStyle(Paint.Style.STROKE);border.setStrokeWidth(shared.borderWidth(2));
  canvas.drawRoundRect(x,y,right,bottom,shared.cornerRadius(8),shared.cornerRadius(8),border);
  int save=canvas.save();
  try {
   canvas.clipRect(x+8,y+8,right-8,bottom-8);
   text(canvas,heading,x+16,y+27,17,Color.rgb(190,190,190));
   if(frame.bodyVisible && body!=null) {canvas.clipRect(x+8,y+42,right-8,bottom-8);body.draw(canvas);}
  } finally {canvas.restoreToCount(save);}
 }
 public static List<String> wrap(String text,Paint paint,float width) {
  if(width<=0) throw new IllegalArgumentException("Invalid wrap width");
  List<String> lines=new ArrayList<>();
  for(String paragraph:text.split("\n",-1)) {
   if(paragraph.isEmpty()) { lines.add(""); continue; }
   while(!paragraph.isEmpty()) {
    int n=paint.breakText(paragraph,true,width,null); if(n<1) n=Character.charCount(paragraph.codePointAt(0));
    if(n<paragraph.length() && Character.isHighSurrogate(paragraph.charAt(n-1))) n--;
    if(n<=0) n=Character.charCount(paragraph.codePointAt(0));
    int space=paragraph.lastIndexOf(' ',n); if(n<paragraph.length() && space>0) n=space;
    lines.add(paragraph.substring(0,n)); paragraph=paragraph.substring(n).replaceFirst("^ +","");
   }
  }
  return lines;
 }
 public static Bitmap layers(int width,int height,Bitmap... layers) {
  Protocol.frameSize(width,height); Bitmap out=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888); Canvas c=new Canvas(out); c.drawColor(Color.BLACK);
  for(Bitmap layer:layers) c.drawBitmap(layer,0,0,null); return out;
 }
 private Ui() {}
}
