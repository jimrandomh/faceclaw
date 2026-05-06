package com.faceclaw.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import android.util.Log;

public final class BleImageOptimizer {
    private BleImageOptimizer() {}
    private static final String TAG = "BleImageOptimizer";

    /**
     * Split an image into fragments (packets), taking advantage of the fact that each packet can declare
     * a logical size longer than its byte payload to get free trailing zero-padding.
     *
     * Each fragment's logical size stays within maxFragmentSize, while trailing zeros inside that span can
     * be omitted from the payload.
     */
    public static List<BleProtocol.ImageFragment> planImageFragments(byte[] bmp, int maxFragmentSize) {
        return planImageFragments(bmp, maxFragmentSize, false);
    }

    public static List<BleProtocol.ImageFragment> planImageFragments(
        byte[] bmp,
        int maxFragmentSize,
        boolean reserveFinalByte
    ) {
        if (bmp == null || bmp.length == 0) {
            return Collections.singletonList(new BleProtocol.ImageFragment(0, new byte[0], 0));
        }
        if (maxFragmentSize <= 0) {
            throw new IllegalArgumentException("maxFragmentSize must be positive");
        }

        final int bulkLength = reserveFinalByte ? bmp.length - 1 : bmp.length;
        final int fragmentCount = ((bulkLength + maxFragmentSize - 1) / maxFragmentSize)
                + (bulkLength < bmp.length ? 1 : 0);
        final List<BleProtocol.ImageFragment> fragments = new ArrayList<>(fragmentCount);
        for (int index = 0; index * maxFragmentSize < bulkLength; index++) {
            int start = index * maxFragmentSize;
            int end = Math.min(start + maxFragmentSize, bulkLength);
            fragments.add(buildFragment(index, bmp, start, end));
        }
        if (bulkLength < bmp.length) {
            fragments.add(new BleProtocol.ImageFragment(
                fragments.size(),
                Arrays.copyOfRange(bmp, bulkLength, bmp.length),
                bmp.length - bulkLength
            ));
        }
        Log.i(TAG, "planImageFragments: fragments=" + fragments.size() + ", bmp.length=" + bmp.length + ", maxFragmentSize=" + maxFragmentSize);
        return fragments;
    }

    private static BleProtocol.ImageFragment buildFragment(int index, byte[] bmp, int start, int end) {
        int dataEnd = end;
        while (dataEnd > start && bmp[dataEnd - 1] == 0) {
            dataEnd -= 1;
        }
        if (dataEnd == start) {
            return new BleProtocol.ImageFragment(index, new byte[0], end - start);
        }
        return new BleProtocol.ImageFragment(
            index,
            Arrays.copyOfRange(bmp, start, dataEnd),
            end - start
        );
    }

    public static final class TileImagePlan {
        final int tileIndex;
        final BleProtocol.ImageTileOptions tile;
        final byte[] bmp;
        final int sessionId;
        List<BleProtocol.ImageFragment> fragments = Collections.emptyList();

        TileImagePlan(int tileIndex, BleProtocol.ImageTileOptions tile, byte[] bmp, int sessionId) {
            this.tileIndex = tileIndex;
            this.tile = tile;
            this.bmp = BmpUtil.copyTileBmp(bmp);
            this.sessionId = sessionId;
        }
    }

    public static final class ImageUpdateStats {
        final int paintMs;
        final int tileCount;
        long firstWriteStartedAtMs;

        ImageUpdateStats(int paintMs, int tileCount) {
            this.paintMs = Math.max(0, paintMs);
            this.tileCount = tileCount;
        }
    }
}
