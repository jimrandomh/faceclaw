package com.faceclaw.sdk;
import org.junit.Test;
import static org.junit.Assert.*;
public class ProtocolTest {
 @Test public void largestViewportHasBoundedAllocation() { assertEquals(307200,Protocol.frameSize(640,480)); }
 @Test public void rejectsEmptyNegativeOverflowAndOversizedViewports() {
  for(int[] pair:new int[][]{{0,1},{1,0},{-1,1},{Integer.MAX_VALUE,2},{641,1},{1,481}}) {
   try { Protocol.frameSize(pair[0],pair[1]); fail("Untrusted dimensions accepted"); } catch(IllegalArgumentException expected) {}
  }
 }
}
