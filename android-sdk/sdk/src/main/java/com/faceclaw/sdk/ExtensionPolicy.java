package com.faceclaw.sdk;

import java.util.*;

/** Pure priority resolver. App declarations cannot write the user's order or grants. */
public final class ExtensionPolicy {
 public static final class Candidate {
  public final String component,feature; public final boolean enabled,granted,available; public final List<String> requires;
  public Candidate(String component,String feature,boolean enabled,boolean granted,boolean available,List<String> requires) {
   this.component=component; this.feature=feature; this.enabled=enabled; this.granted=granted; this.available=available; this.requires=new ArrayList<>(requires);
  }
 }
 public static Candidate winner(String feature,List<Candidate> candidates,Map<String,List<String>> orders) { return resolve(feature,candidates,orders,new HashSet<>()); }
 public static boolean available(String feature,List<Candidate> candidates,Map<String,List<String>> orders) { return available(feature,candidates,orders,new HashSet<>()); }
 /** Stable diagnostic codes; no user content or preference values. */
 public static String reason(Candidate candidate,List<Candidate> candidates,Map<String,List<String>> orders) {
  if(!candidate.enabled) return "disabled";
  if(!candidate.granted) return "grant-required";
  for(String dependency:candidate.requires) {
   Candidate required=winner(dependency,candidates,orders);
   if(required==null||!required.component.equals(candidate.component)) return "dependency-owner";
   if(!available(dependency,candidates,orders)) return "dependency-unavailable";
  }
  if(ExtensionContract.live(candidate.feature)&&!candidate.available) return "disconnected";
  Candidate selected=winner(candidate.feature,candidates,orders);
  return selected!=null&&selected.component.equals(candidate.component)?"active":"lower-priority";
 }
 private static boolean available(String feature,List<Candidate> candidates,Map<String,List<String>> orders,Set<String> visiting) {
  if(!visiting.add(feature)) return false;
  try {
   Candidate selected=winner(feature,candidates,orders);
   if(selected==null||(ExtensionContract.live(feature)&&!selected.available)) return false;
   for(String dependency:selected.requires) if(!available(dependency,candidates,orders,visiting)) return false;
   return true;
  } finally { visiting.remove(feature); }
 }
 private static Candidate resolve(String feature,List<Candidate> candidates,Map<String,List<String>> orders,Set<String> visiting) {
  if(!visiting.add(feature)) return null;
  try {
   List<Candidate> options=new ArrayList<>();
   for(Candidate candidate:candidates) if(candidate.feature.equals(feature)&&candidate.enabled&&candidate.granted) options.add(candidate);
   List<String> order=orders.getOrDefault(feature,Collections.emptyList());
   options.sort(Comparator.comparingInt((Candidate candidate)->{ int index=order.indexOf(candidate.component); return index<0?Integer.MAX_VALUE:index; }).thenComparing(candidate->candidate.component));
   for(Candidate option:options) {
    boolean eligible=true;
    for(String dependency:option.requires) { Candidate required=resolve(dependency,candidates,orders,visiting); if(required==null||!required.component.equals(option.component)) { eligible=false; break; } }
    if(eligible) return option;
   }
   return null;
  } finally { visiting.remove(feature); }
 }
 private ExtensionPolicy() {}
}
