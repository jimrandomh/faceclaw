package com.faceclaw.app;
import java.nio.ByteBuffer;
public interface FaceclawExternalAppListener {
 void onEvent(String component,String type,String json);
 void onExtensionFrame(String component,String feature,long generation,int width,int height,ByteBuffer pixels);
 void onFrame(String component,int width,int height,ByteBuffer pixels);
}
