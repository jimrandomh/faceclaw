package com.faceclaw.app;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public final class NotificationCompositorCheck {
    private static ByteBuffer draws(int glyph) {
        ByteBuffer buffer = ByteBuffer.allocate(21).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put((byte) 0).putShort((short) 1).putInt(glyph).putShort((short) 0).putShort((short) 0).put((byte) 255);
        buffer.put((byte) 1).putInt(glyph + 1).putShort((short) 0).putShort((short) 0);
        buffer.flip();
        return buffer;
    }
    private static void pixels(SurfaceCompositor.Composite frame, int... expected) {
        for (int i = 0; i < expected.length; i++) {
            if ((frame.gray[i] & 255) != expected[i]) throw new AssertionError("pixel " + i + " = " + (frame.gray[i] & 255) + ", expected " + expected[i]);
        }
    }
    public static void main(String[] args) {
        SurfaceCompositor compositor = new SurfaceCompositor();
        compositor.configureScreen(3, 1);
        compositor.configureSurface("private-app", 0, 0, 3, 1, 0, SurfaceCompositor.TRANSPARENCY_OPAQUE);
        compositor.configureSurface("notification", 0, 0, 3, 1, 1, SurfaceCompositor.TRANSPARENCY_COLOR_KEY);
        compositor.configureSurface("lock", 0, 0, 3, 1, 1000, SurfaceCompositor.TRANSPARENCY_COLOR_KEY);
        compositor.setSurfaceVisible("lock", false);
        compositor.applyAndComposite("private-app", ByteBuffer.wrap(new byte[] {(byte) 180, 80, (byte) 255}), 0, 0, 3, 1, "secret-one", draws(900));
        compositor.applyAndComposite("notification", ByteBuffer.wrap(new byte[] {0, (byte) 200, 0}), 0, 0, 3, 1, "preview");
        compositor.setUnderlayDim(1, 0);
        SurfaceCompositor.Composite hidden = compositor.composite();
        pixels(hidden, 0, 200, 0);
        pixels(compositor.previewComposite(), 0, 200, 0);
        if (hidden.draws.length != 0) throw new AssertionError("hidden glyph/image identities leaked");
        if (hidden.fingerprint.contains("secret-one")) throw new AssertionError("hidden content fingerprint leaked");
        SurfaceCompositor.Composite updated = compositor.applyAndComposite("private-app", ByteBuffer.wrap(new byte[] {90, 40, 100}), 0, 0, 3, 1, "secret-two", draws(950));
        pixels(updated, 0, 200, 0);
        pixels(compositor.previewComposite(), 0, 200, 0);
        if (!hidden.fingerprint.equals(updated.fingerprint)) throw new AssertionError("hidden update changed preview fingerprint");
        compositor.applyAndComposite("lock", ByteBuffer.wrap(new byte[] {0, 0, (byte) 222}), 0, 0, 3, 1, "lock");
        compositor.setSurfaceVisible("lock", true);
        pixels(compositor.composite(), 0, 200, 222);
        pixels(compositor.previewComposite(), 0, 200, 222);
        compositor.setSurfaceVisible("lock", false);
        compositor.setUnderlayDim(1, 128);
        SurfaceCompositor.Composite dimmed = compositor.composite();
        pixels(dimmed, 45, 200, 50);
        pixels(compositor.previewComposite(), 45, 200, 50);
        if (dimmed.draws.length != 1 || dimmed.draws[0].value != 128) throw new AssertionError("positive dimming changed");
        compositor.setUnderlayDim(1, 256);
        SurfaceCompositor.Composite restored = compositor.composite();
        pixels(restored, 90, 200, 100);
        pixels(compositor.previewComposite(), 90, 200, 100);
        if (restored.draws.length != 2 || restored.draws[0].encoding != 950) throw new AssertionError("retained content did not restore");
    }
}
