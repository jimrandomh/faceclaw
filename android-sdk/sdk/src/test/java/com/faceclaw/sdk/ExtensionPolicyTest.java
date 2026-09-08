package com.faceclaw.sdk;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;
public class ExtensionPolicyTest {
 private ExtensionPolicy.Candidate candidate(String owner,String feature,boolean enabled,boolean grant,boolean live,String... requires) { return new ExtensionPolicy.Candidate(owner,feature,enabled,grant,live,Arrays.asList(requires)); }
 @Test public void onlyExplicitlyGrantedEnabledOwnersCanWin() {
  List<ExtensionPolicy.Candidate> candidates=Arrays.asList(candidate("ungranted","ui.typography",true,false,true),candidate("disabled","ui.typography",false,true,true),candidate("approved","ui.typography",true,true,true));
  assertEquals("approved",ExtensionPolicy.winner("ui.typography",candidates,Collections.emptyMap()).component);
 }
 @Test public void userPriorityWinsAndDisabledWinnerRevealsNextEnabledOwner() {
  Map<String,List<String>> order=Collections.singletonMap("ui.typography",Arrays.asList("c","b","a"));
  List<ExtensionPolicy.Candidate> candidates=Arrays.asList(candidate("a","ui.typography",true,true,true),candidate("b","ui.typography",true,true,true),candidate("c","ui.typography",false,true,true));
  assertEquals("b",ExtensionPolicy.winner("ui.typography",candidates,order).component);
 }
 @Test public void offlineWinnerKeepsSelectionAndAvailabilityForHostFallback() {
  List<ExtensionPolicy.Candidate> candidates=Arrays.asList(candidate("a","assistant",true,true,false),candidate("b","assistant",true,true,true));
  ExtensionPolicy.Candidate winner=ExtensionPolicy.winner("assistant",candidates,Collections.emptyMap());
  assertEquals("a",winner.component); assertFalse(winner.available);
 }
 @Test public void bundlesPartlyWinAndDependenciesRequireSameOwner() {
  List<ExtensionPolicy.Candidate> candidates=Arrays.asList(candidate("a","ui.typography",true,true,true),candidate("b","ui.typography",true,true,true),candidate("b","ui.notifications",true,true,true,"ui.typography"),candidate("b","ui.launcher",true,true,true));
  assertNull(ExtensionPolicy.winner("ui.notifications",candidates,Collections.emptyMap()));
  assertEquals("b",ExtensionPolicy.winner("ui.launcher",candidates,Collections.emptyMap()).component);
  assertEquals("b",ExtensionPolicy.winner("ui.notifications",candidates,Collections.singletonMap("ui.typography",Arrays.asList("b","a"))).component);
 }
 @Test public void persistedConfigurationKeepsWorkingUnlessItRequiresAnOfflineLiveFeature() {
  List<ExtensionPolicy.Candidate> candidates=Arrays.asList(candidate("a","ui.typography",true,true,false),candidate("a","ui.window-layout",true,true,false,"ui.launcher"),candidate("a","ui.launcher",true,true,false));
  assertTrue(ExtensionPolicy.available("ui.typography",candidates,Collections.emptyMap()));
  assertFalse(ExtensionPolicy.available("ui.window-layout",candidates,Collections.emptyMap()));
 }
 @Test public void cyclicUntrustedDependenciesFailClosed() {
  List<ExtensionPolicy.Candidate> candidates=Arrays.asList(candidate("a","assistant",true,true,true,"refinement"),candidate("a","refinement",true,true,true,"assistant"));
  assertNull(ExtensionPolicy.winner("assistant",candidates,Collections.emptyMap()));
 }
}
