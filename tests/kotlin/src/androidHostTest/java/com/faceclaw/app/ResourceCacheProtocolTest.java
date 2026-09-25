package com.faceclaw.app;

import java.util.*;

/** Android's Java communicator and iOS share the same resource API and wire commands. */
public class ResourceCacheProtocolTest {
    public static void main(String[] args) {
        ResourceCacheState cache = new ResourceCacheState();
        CachedResource image = new CachedResource(new byte[]{1, 1, 31});
        assert cache.prepare(Collections.singletonList(image))[0] == 0;
        List<byte[]> commands = cache.drainCommands(3600);
        assert commands.size() == 2 && commands.get(0)[0] == 22;
        assert Arrays.equals(commands.get(1), new byte[]{21,1,0,0,0,3,0,0,0,0,0,3,0,1,1,31});
        assert cache.prepare(Collections.singletonList(image))[0] == 0;
        assert cache.drainCommands(3600).isEmpty();
        cache.reset();
        assert cache.prepare(Collections.singletonList(image))[0] == 0;
        assert cache.drainCommands(3600).get(0)[0] == 22;
    }
}
