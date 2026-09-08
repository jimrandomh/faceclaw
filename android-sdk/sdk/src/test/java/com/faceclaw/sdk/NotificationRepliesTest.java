package com.faceclaw.sdk;
import org.junit.Test;
import static org.junit.Assert.*;
public class NotificationRepliesTest {
 @Test public void replyRequiresExactLiveTargetAndSingleUseToken() {
  NotificationReplies replies=new NotificationReplies(); replies.publish("id","target","token",1000,1);
  assertFalse(replies.consume("other","target","token",2)); assertFalse(replies.consume("id","foreign","token",2));
  assertFalse(replies.consume("id","target","wrong",2)); assertTrue(replies.consume("id","target","token",2));
  replies.publish("id","target","token",1000,3); assertFalse(replies.consume("id","target","token",3));
  assertFalse(replies.report("id","token","untrusted-text",3)); assertTrue(replies.report("id","token","sent",3));
  assertFalse(replies.report("id","token","sent",3));
 }
 @Test public void changedExpiredRemovedAndDisconnectedTokensCannotSendOrReport() {
  for(int mode=0;mode<4;mode++) {
   NotificationReplies replies=new NotificationReplies(); replies.publish("id","target","token",1000,1);
   if(mode==0) replies.publish("id","target","replacement",1000,2);
   if(mode==1) replies.publish("id","target","token",1000,2);
   if(mode==2) replies.remove("id"); if(mode==3) replies.clear();
   assertFalse(replies.consume("id","target","token",mode==1?1000:3)); assertFalse(replies.report("id","token","sent",3));
  }
 }
 @Test public void resultRequiresAConsumedMatchingActionAndRegistryIsBounded() {
  NotificationReplies replies=new NotificationReplies();
  for(int i=0;i<33;i++) replies.publish("id"+i,"target","token"+i,1000,1);
  assertFalse(replies.consume("id32","target","token32",2)); assertFalse(replies.report("id0","token0","sent",2));
  assertTrue(replies.consume("id0","target","token0",2)); assertFalse(replies.report("id0","wrong","sent",2));
  assertTrue(replies.report("id0","token0","draft-saved",2));
 }
}
