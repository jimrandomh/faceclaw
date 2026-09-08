package com.faceclaw.sdk;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.*;
import java.nio.channels.FileLock;
import java.util.UUID;

/** Binds private capability preferences to this installation, excluding restored backup grants. */
public final class ApprovalStore {
 public static SharedPreferences open(Context context,String namespace) {
  if(!namespace.matches("[a-z][a-z-]{0,63}")) throw new IllegalArgumentException("Invalid approval namespace");
  SharedPreferences prefs=context.getSharedPreferences(namespace,Context.MODE_PRIVATE);
  File marker=new File(context.getNoBackupFilesDir(),namespace+".installation");
  try(RandomAccessFile file=new RandomAccessFile(marker,"rw"); FileLock lock=file.getChannel().lock()) {
   String nonce="";
   if(file.length()>0 && file.length()<100) { try { nonce=file.readUTF(); } catch(IOException ignored) { /* Incomplete marker invalidates restored grants. */ } }
   if(!nonce.matches("[a-f0-9-]{36}")) { nonce=UUID.randomUUID().toString(); file.setLength(0); file.seek(0); file.writeUTF(nonce); file.getFD().sync(); }
   if(!nonce.equals(prefs.getString("installation",""))) {
    if(!prefs.edit().clear().putString("installation",nonce).commit()) throw new IOException("Approval storage unavailable");
   }
   return prefs;
  } catch(IOException e) { throw new IllegalStateException("Approval storage unavailable",e); }
 }
 private ApprovalStore() {}
}
