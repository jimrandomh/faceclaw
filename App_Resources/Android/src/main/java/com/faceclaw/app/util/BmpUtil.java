package com.faceclaw.app;
import java.util.Arrays;

public class BmpUtil {
    public static byte[] copyTileBmp(byte[] bmp) {
        if (bmp == null || bmp.length == 0) {
            return new byte[0];
        }
        return Arrays.copyOf(bmp, bmp.length);
    }

    public static byte[] buildBlankWarmupBmp(byte[] bmp) {
        byte[] warmup = BmpUtil.copyTileBmp(bmp);
        int pixelOffset = readBmpPixelOffset(warmup);
        if (pixelOffset <= 0 || pixelOffset >= warmup.length) {
            Arrays.fill(warmup, (byte) 0);
            return warmup;
        }
        Arrays.fill(warmup, pixelOffset, warmup.length, (byte) 0);
        return warmup;
    }

    public static int readBmpPixelOffset(byte[] bmp) {
        if (bmp == null || bmp.length < 14 || bmp[0] != 0x42 || bmp[1] != 0x4d) {
            return -1;
        }
        return (bmp[10] & 0xff)
              | ((bmp[11] & 0xff) << 8)
              | ((bmp[12] & 0xff) << 16)
              | ((bmp[13] & 0xff) << 24);
    }
}
