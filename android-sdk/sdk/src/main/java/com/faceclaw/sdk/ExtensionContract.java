package com.faceclaw.sdk;

import org.json.*;
import java.util.*;

/** Versioned, bounded extension messages. Keys never name host preferences or native objects. */
public final class ExtensionContract {
 /** Snapshot schema and wire protocol remain v1; extension behavior is negotiated separately. */
 public static final int SEMANTICS=2;
 public static final String SDK_VERSION="0.2.0";
 public static int peerSemantics(JSONObject data) {
  Object value=data.opt("extensionSemantics");
  if(!(value instanceof Number)) return 0;
  double number=((Number)value).doubleValue();
  return Double.isFinite(number)&&number>=0&&number<=Integer.MAX_VALUE&&number==Math.floor(number)?(int)number:0;
 }
 public static boolean compatible(int semantics) { return semantics==SEMANTICS; }
 public static final int VERSION=1, MAX_FEATURES=11, MAX_CONFIG=8192;
 public static final List<String> FEATURES=Collections.unmodifiableList(Arrays.asList("ui.launcher","ui.navigation","ui.app-menu","ui.window-layout","ui.typography","ui.notifications","assistant","transcription","refinement","device-tools","notification-content"));
 public static boolean known(String feature) { return FEATURES.contains(feature); }
 public static boolean live(String feature) { return known(feature)&&!Arrays.asList("ui.navigation","ui.window-layout","ui.typography").contains(feature); }
 public static boolean surface(String feature) { return Arrays.asList("ui.launcher","ui.app-menu","ui.notifications").contains(feature); }
 public static boolean token(String value) { return value!=null&&value.matches("[A-Za-z0-9_-]{1,128}"); }
 public static boolean action(String feature,String action) {
  if(!known(feature)||action==null) return false;
  if(feature.equals("device-tools")) return action.equals("tool-call");
  if(feature.equals("ui.notifications")) return Arrays.asList("notification-open","notification-dismiss","notification-dismiss-group","notification-review-reply","notification-cancel-review","notification-action","close-surface","sleep").contains(action);
  if(feature.equals("ui.launcher")&&action.equals("uninstall-app")) return true;
  return (feature.equals("ui.launcher")||feature.equals("ui.app-menu"))&&Arrays.asList("open-app","close-app","focus-app","show-app-menu","request-dictation","close-surface","sleep","menu-select").contains(action);
 }
 public static JSONObject configuration(JSONObject data) throws JSONException {
  if(data==null||data.toString().length()>MAX_CONFIG||data.length()>32) throw new IllegalArgumentException("Invalid extension configuration");
  Iterator<String> keys=data.keys();
  while(keys.hasNext()) {
   String key=keys.next(); Object value=data.get(key);
   if(!key.matches("[a-zA-Z][a-zA-Z0-9_-]{0,63}")) throw new IllegalArgumentException("Invalid configuration key");
   if(value instanceof Boolean) continue;
   if(value instanceof String && ((String)value).length()<=512) continue;
   if(value instanceof Number && Double.isFinite(((Number)value).doubleValue())&&Math.abs(((Number)value).doubleValue())<=1000000) continue;
   throw new IllegalArgumentException("Configuration values must be bounded scalar tokens");
  }
  return new JSONObject(data.toString());
 }
 public static JSONObject configuration(String feature,JSONObject data) throws JSONException {
  configuration(data);
  Map<String,String> rules=new HashMap<>();
  if(feature.equals("ui.launcher")) { rules.put("label","text"); rules.put("filesDefaultView","icons|list"); }
  else if(feature.equals("ui.navigation")) { rules.put("rootBack","sleep|switcher"); rules.put("doubleTap","back|sleep"); rules.put("tapHold","switcher|app-menu"); rules.put("hold","app-menu|system-menu"); rules.put("wakeFocus","window|sidebar"); }
  else if(feature.equals("ui.window-layout")) { rules.put("centered","boolean"); rules.put("sidebarMode","overlay|persistent"); rules.put("switcherHeight","display|minimum"); rules.put("dividerWidth","1:4"); rules.put("ownTopBar","boolean"); rules.put("ownHeightMode","min|medium|max"); rules.put("inputDialogs","compact|viewport"); }
  else if(feature.equals("ui.typography")) { rules.put("font","(?:Inter_18pt|Roboto|RobotoMono|Montserrat)-(?:Regular|Light|Bold)\\.ttf"); rules.put("size","8:20"); rules.put("raster","antialiased|crisp|hinted"); rules.put("borderWidth","1:4"); rules.put("selectionBorderWidth","1:5"); rules.put("cardRadius","0:24"); }
  else if(feature.equals("ui.app-menu")) { rules.put("title","text"); rules.put("systemTitle","text"); rules.put("displayOffFirst","boolean"); rules.put("systemActionsLast","boolean"); }
  else rules.put("label","text");
  for(Iterator<String> keys=data.keys();keys.hasNext();) {
   String key=keys.next(),rule=rules.get(key); Object value=data.get(key);
   if(rule==null) throw new IllegalArgumentException("Unknown feature configuration");
   if(rule.equals("boolean")) { if(!(value instanceof Boolean)) throw new IllegalArgumentException("Expected boolean"); }
   else if(rule.equals("text")) { if(!(value instanceof String)||((String)value).length()>100||((String)value).matches("(?s).*[\\p{Cntrl}].*")) throw new IllegalArgumentException("Invalid label"); }
   else if(rule.matches("[0-9]+:[0-9]+")) { String[] bounds=rule.split(":"); if(!(value instanceof Number)||((Number)value).doubleValue()!=((Number)value).intValue()||((Number)value).intValue()<Integer.parseInt(bounds[0])||((Number)value).intValue()>Integer.parseInt(bounds[1])) throw new IllegalArgumentException("Invalid configuration range"); }
   else if(!(value instanceof String)||!((String)value).matches(rule)) throw new IllegalArgumentException("Unknown configuration token");
  }
  return new JSONObject(data.toString());
 }
 public static JSONArray declarations(JSONArray supplied) throws JSONException {
  if(supplied==null||supplied.length()>MAX_FEATURES||supplied.toString().length()>Protocol.MAX_JSON) throw new IllegalArgumentException("Too many extensions");
  JSONArray result=new JSONArray(); Set<String> features=new HashSet<>(); Map<String,List<String>> dependencies=new HashMap<>();
  for(int i=0;i<supplied.length();i++) {
   JSONObject item=supplied.getJSONObject(i); String feature=item.getString("feature");
   if(!known(feature)||!features.add(feature)||!(item.opt("enabled") instanceof Boolean)) throw new IllegalArgumentException("Invalid extension declaration");
   for(Iterator<String> keys=item.keys();keys.hasNext();) if(!Arrays.asList("feature","enabled","configuration","requires").contains(keys.next())) throw new IllegalArgumentException("Unknown declaration field");
   JSONObject config=configuration(feature,item.getJSONObject("configuration")); JSONArray requires=item.has("requires")?item.getJSONArray("requires"):new JSONArray();
   if(requires.length()>MAX_FEATURES) throw new IllegalArgumentException("Too many dependencies");
   List<String> deps=new ArrayList<>();
   for(int n=0;n<requires.length();n++) { String dep=requires.getString(n); if(!known(dep)||dep.equals(feature)||deps.contains(dep)) throw new IllegalArgumentException("Invalid dependency"); deps.add(dep); }
   dependencies.put(feature,deps); result.put(Protocol.object("feature",feature,"enabled",item.getBoolean("enabled"),"configuration",config,"requires",new JSONArray(deps)));
  }
  for(String feature:features) checkDependencies(feature,dependencies,new HashSet<>());
  return result;
 }
 private static void checkDependencies(String feature,Map<String,List<String>> dependencies,Set<String> visiting) {
  if(!dependencies.containsKey(feature)||!visiting.add(feature)) throw new IllegalArgumentException("Missing or cyclic dependency");
  for(String dependency:dependencies.get(feature)) checkDependencies(dependency,dependencies,visiting);
  visiting.remove(feature);
 }
 private ExtensionContract() {}
}
