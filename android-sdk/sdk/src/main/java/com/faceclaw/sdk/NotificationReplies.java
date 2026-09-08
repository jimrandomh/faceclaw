package com.faceclaw.sdk;

import java.util.*;

/** Session-local published actions. No backend credentials or message content. */
final class NotificationReplies {
 private static final class Entry {
  final String target,token; final long expires; boolean consumed,reported;
  Entry(String target,String token,long expires) { this.target=target;this.token=token;this.expires=expires; }
 }
 private final Map<String,Entry> entries=new LinkedHashMap<>();
 synchronized void publish(String id,String target,String token,long expires,long now) {
  entries.entrySet().removeIf(e->e.getValue().expires<=now);
  Entry old=entries.get(id);
  if(token==null||token.isEmpty()||token.length()>128||expires<=now) { entries.remove(id); return; }
  if(old!=null&&old.target.equals(target)&&old.token.equals(token)) return;
  if(!entries.containsKey(id)&&entries.size()>=32) return;
  entries.put(id,new Entry(target,token,Math.min(expires,now+30L*86400000)));
 }
 synchronized boolean consume(String id,String target,String token,long now) {
  Entry entry=entries.get(id);
  if(entry==null||entry.consumed||entry.expires<=now||!entry.target.equals(target)||!entry.token.equals(token)) return false;
  entry.consumed=true;return true;
 }
 synchronized boolean report(String id,String token,String status,long now) {
  Entry entry=entries.get(id);
  if(entry==null||!entry.consumed||entry.reported||entry.expires<=now||!entry.token.equals(token)||
    !(status.equals("sent")||status.equals("draft-saved")||status.equals("unknown")||status.equals("rejected"))) return false;
  entry.reported=true;return true;
 }
 synchronized void remove(String id) { entries.remove(id); }
 synchronized void clear() { entries.clear(); }
}
