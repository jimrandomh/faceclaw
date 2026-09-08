package com.faceclaw.sdk;

import android.content.Context;
import android.content.pm.*;
import android.os.Build;
import java.security.MessageDigest;
import java.util.*;
/** Pin the complete current signer set; no shared-UID or caller-asserted identity. */
public final class PackageIdentity {
 public static String forUid(Context context,int uid) throws Exception {
  String[] packages=context.getPackageManager().getPackagesForUid(uid);
  if(packages==null || packages.length!=1) throw new SecurityException("Ambiguous caller");
  return forPackage(context,packages[0]);
 }
 public static String forPackage(Context context,String name) throws Exception {
  PackageManager pm=context.getPackageManager();
  PackageInfo info=pm.getPackageInfo(name,Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES);
  Signature[] signatures=Build.VERSION.SDK_INT>=28?info.signingInfo.getApkContentsSigners():info.signatures;
  if(signatures==null || signatures.length==0) throw new SecurityException("Unsigned package");
  List<String> hashes=new ArrayList<>();
  for(Signature signature:signatures) {
   byte[] digest=MessageDigest.getInstance("SHA-256").digest(signature.toByteArray());
   StringBuilder value=new StringBuilder(); for(byte b:digest) value.append(String.format(java.util.Locale.ROOT,"%02x",b&255)); hashes.add(value.toString());
  }
  Collections.sort(hashes);
  return info.applicationInfo.uid+":"+name+":"+String.join(",",hashes);
 }
 public static String packageName(String identity) { return identity.split(":",3)[1]; }
 private PackageIdentity() {}
}
