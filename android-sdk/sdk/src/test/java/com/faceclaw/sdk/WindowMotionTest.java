package com.faceclaw.sdk;

import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class WindowMotionTest {
    private final WindowMotion.Rect compact = new WindowMotion.Rect(259,149,288,44), expanded = new WindowMotion.Rect(0,0,571,447);
    private void assertRect(WindowMotion.Rect a, WindowMotion.Rect b) { assertEquals(a.x,b.x,0); assertEquals(a.y,b.y,0); assertEquals(a.width,b.width,0); assertEquals(a.height,b.height,0); }
    @Test public void sharedFixturesMatchJavascript() throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/window-motion-v1.csv"), StandardCharsets.UTF_8))) {
            reader.readLine(); String line;
            while ((line = reader.readLine()) != null) {
                String[] values = line.split(","); boolean closing = values[0].equals("1"); long elapsed = Long.parseLong(values[1]);
                WindowMotion motion = new WindowMotion(closing ? expanded : compact, closing ? compact : expanded, closing);
                WindowMotion.Frame frame = motion.sample(1000); if (elapsed > 0) frame = motion.sample(1000 + elapsed);
                assertRect(new WindowMotion.Rect(Double.parseDouble(values[2]),Double.parseDouble(values[3]),Double.parseDouble(values[4]),Double.parseDouble(values[5])),frame.rect);
                assertEquals(values[6].equals("1"),frame.bodyVisible); assertEquals(values[7].equals("1"),frame.done);
            }
        }
    }
    @Test public void delayedFramesFinishWithoutReplayingBacklog() {
        WindowMotion motion = new WindowMotion(compact,expanded,false); motion.sample(1000);
        WindowMotion.Frame frame = motion.sample(9000); assertTrue(frame.done); assertRect(expanded,frame.rect); assertNull(motion.sample(9040));
    }
    @Test public void reversalUsesLastDrawnGeometryAndHidesBodyBeforeMoving() {
        WindowMotion motion = new WindowMotion(compact,expanded,false); motion.sample(1000); WindowMotion.Frame visible = motion.sample(1324); assertTrue(visible.bodyVisible);
        motion.retarget(compact,true); WindowMotion.Frame reversed = motion.sample(5000); assertRect(visible.rect,reversed.rect); assertFalse(reversed.bodyVisible); assertRect(compact,motion.sample(5360).rect);
    }
    @Test public void cancellationNeverEmitsStaleFrame() { WindowMotion motion = new WindowMotion(compact,expanded,false); motion.sample(0); motion.cancel(); assertNull(motion.sample(100)); }
}
