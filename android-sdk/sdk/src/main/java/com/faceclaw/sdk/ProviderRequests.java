package com.faceclaw.sdk;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** App-side, single-use request tracking. Call on the main looper; host authorization still applies. */
public final class ProviderRequests {
    private final Map<String, HostEvent.Provider> pending = new HashMap<>();
    private static String key(HostEvent.Provider event) { return event.feature + "\n" + event.generation + "\n" + event.requestId; }
    public boolean begin(HostEvent.Provider event, long nowMillis) {
        pending.values().removeIf(request -> request.isExpired(nowMillis));
        if (!event.isRequest() || event.isExpired(nowMillis) || pending.size() >= 128 || pending.containsKey(key(event))) return false;
        pending.put(key(event), event); return true;
    }
    /** Consume before publishing a final result. False means drop it, never replay it elsewhere. */
    public boolean complete(HostEvent.Provider event, long nowMillis) {
        if (pending.get(key(event)) != event) return false;
        pending.remove(key(event)); return !event.isExpired(nowMillis);
    }
    public void accept(HostEvent event) {
        if (event instanceof HostEvent.Provider) {
            HostEvent.Provider provider = (HostEvent.Provider) event;
            if (provider.isCancellation()) pending.remove(key(provider));
        } else if (event instanceof HostEvent.Extensions) {
            HostEvent.Extensions snapshot = (HostEvent.Extensions) event;
            Iterator<HostEvent.Provider> iterator = pending.values().iterator();
            while (iterator.hasNext()) {
                HostEvent.Provider request = iterator.next();
                HostEvent.Feature feature = snapshot.feature(request.feature);
                if (feature == null || (!request.ownCapture && !feature.available) || feature.generation != request.generation) iterator.remove();
            }
        }
    }
    public void disconnect() { pending.clear(); }
}
