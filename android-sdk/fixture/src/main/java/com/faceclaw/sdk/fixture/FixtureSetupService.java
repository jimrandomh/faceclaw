package com.faceclaw.sdk.fixture;
import android.app.Service;
import android.content.Intent;
import android.os.*;
import com.faceclaw.sdk.PackageIdentity;
/** Test-only setup endpoint; authorizes the caller's actual UID and matching debug signer. */
public final class FixtureSetupService extends Service {
 private final Binder binder=new Binder() {
  @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags) throws RemoteException {
   if(code!=1) return super.onTransact(code,data,reply,flags);
   data.enforceInterface("com.faceclaw.sdk.fixture.Setup");
   try {
    String identity=PackageIdentity.forUid(FixtureSetupService.this,Binder.getCallingUid());
    String name=PackageIdentity.packageName(identity);
    if(!name.equals("com.faceclaw.sdk.hosttest")&&!name.equals("com.faceclaw.app")&&!name.equals("com.deejanuz.faceclaw.t3")) throw new SecurityException();
    String own=PackageIdentity.forPackage(FixtureSetupService.this,getPackageName());
    if(!identity.split(":",3)[2].equals(own.split(":",3)[2])) throw new SecurityException();
    com.faceclaw.sdk.ApprovalStore.open(FixtureSetupService.this,"faceclaw-host").edit().putString("identity",identity).commit();
    reply.writeNoException(); return true;
   } catch(Exception e) { throw new SecurityException("Synthetic host not authorized"); }
  }
 };
 @Override public IBinder onBind(Intent intent) { return binder; }
}
