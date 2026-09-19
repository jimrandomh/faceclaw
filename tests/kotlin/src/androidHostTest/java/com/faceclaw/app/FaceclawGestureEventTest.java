package com.faceclaw.app;
import java.util.Arrays;

public class FaceclawGestureEventTest {
    private static byte[] hex(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int i = 0; i < result.length; ++i)
            result[i] = (byte)Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return result;
    }
    private static byte[] pb(byte[] payload) {
        byte[] frame = BleProtocol.framePb(payload, 9, BleProtocol.FLAG_NOTIFY, 15).get(0);
        return BleProtocol.parseFrame(frame).pb;
    }
    /** G2SettingPackage{commandId=3, magic=0, field102=['F','C',1,event,source,0]}: the CFW's wire shape. */
    private static byte[] packet(int event, int source) {
        byte[] p = hex("08031000b20606464301000000");
        p[10] = (byte)event; p[11] = (byte)source;
        return p;
    }
    public static void main(String[] args) {
        // Event codes map to the sys-events a live page would produce.
        int[][] events = {
            {2, BleProtocol.EVENT_CLICK},
            {3, BleProtocol.EVENT_RING_LONG_PRESS},
            {4, BleProtocol.EVENT_RING_LONG_PRESS_RELEASE},
        };
        int[][] sources = {
            {0, BleProtocol.EVENT_SOURCE_GLASSES_L},
            {1, BleProtocol.EVENT_SOURCE_GLASSES_R},
            {4, BleProtocol.EVENT_SOURCE_RING},
            {7, 0},
        };
        for (int[] e : events) for (int[] s : sources) {
            BleProtocol.FaceclawGestureEvent g = BleProtocol.parseFaceclawGestureEvent(pb(packet(e[0], s[0])));
            assert g != null && g.eventType == e[1] && g.eventSource == s[1] : e[0] + "/" + s[0];
        }
        // The double-tap wake event (1) and unknown codes are not gestures, and the
        // wake parser does not mistake a gesture for a wake.
        byte[] wake = packet(1, 0x34); wake[12] = 0x12;
        assert BleProtocol.parseFaceclawGestureEvent(pb(wake)) == null;
        assert BleProtocol.parseFaceclawWakeEvent(pb(wake)) == 0x1234;
        assert BleProtocol.parseFaceclawWakeEventCode(pb(wake)) == 1;
        // The head-up wake (5) shares the nonce handshake but keeps its own code.
        byte[] headUp = packet(5, 0x34); headUp[12] = 0x12;
        assert BleProtocol.parseFaceclawGestureEvent(pb(headUp)) == null;
        assert BleProtocol.parseFaceclawWakeEvent(pb(headUp)) == 0x1234;
        assert BleProtocol.parseFaceclawWakeEventCode(pb(headUp)) == BleProtocol.FACECLAW_WAKE_EVENT_HEAD_UP;
        for (int code : new int[] {2, 3, 4, 6}) {
            assert BleProtocol.parseFaceclawWakeEvent(pb(packet(code, 1))) == -1;
            assert BleProtocol.parseFaceclawWakeEventCode(pb(packet(code, 1))) == -1;
        }
        for (int code : new int[] {0, 5, 6, 255})
            assert BleProtocol.parseFaceclawGestureEvent(pb(packet(code, 1))) == null;
        // Wrong protocol version, wrong magic letters, truncated payloads, plain settings.
        byte[] bad = packet(2, 1); bad[9] = 2;
        assert BleProtocol.parseFaceclawGestureEvent(pb(bad)) == null;
        bad = packet(2, 1); bad[7] = 'X';
        assert BleProtocol.parseFaceclawGestureEvent(pb(bad)) == null;
        byte[] full = packet(2, 1);
        for (int n = 0; n < full.length; ++n)
            assert BleProtocol.parseFaceclawGestureEvent(pb(Arrays.copyOf(full, n))) == null : n;
        assert BleProtocol.parseFaceclawGestureEvent(pb(hex("08031000"))) == null;
        assert BleProtocol.parseFaceclawGestureEvent(null) == null;
        System.out.println("FaceclawGestureEventTest ok");
    }
}
