package com.faceclaw.starter;

import com.faceclaw.sdk.HostEvent;
import com.faceclaw.sdk.WindowState;
import com.faceclaw.sdk.ProviderRequests;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Synthetic event replay in the consumer project; no host, phone or permission bypass. */
public class LifecycleTest {
    private HostEvent replay(String type, String json) throws Exception { return HostEvent.decode(type, new JSONObject(json)); }
    @Test public void frameAllocationStopsOnHideCloseAndDisconnect() throws Exception {
        WindowState window = new WindowState();
        window.accept(replay("open", "{width:320,height:120,generation:1}")); assertFalse(window.canDraw());
        window.accept(replay("visibility", "{visible:true,screenOn:true}")); assertTrue(window.canDraw());
        window.accept(replay("resize", "{width:160,height:80,generation:2}")); assertEquals(160, window.width());
        window.accept(replay("visibility", "{visible:false,screenOn:true}")); assertFalse(window.canDraw());
        window.accept(replay("visibility", "{visible:true,screenOn:true}"));
        window.accept(replay("close", "{}")); assertFalse(window.canDraw());
        window.disconnect(); assertEquals(0, window.height());
    }
    @Test public void cancelledProviderWorkCannotPublishALateResult() throws Exception {
        ProviderRequests requests = new ProviderRequests();
        HostEvent.Provider request = (HostEvent.Provider) replay("extension-event", "{feature:'assistant',generation:4,type:'request',data:{requestId:'synthetic',deadlineAt:500}}");
        assertTrue(requests.begin(request, 100));
        requests.accept(replay("extension-event", "{feature:'assistant',generation:4,type:'cancel',data:{requestId:'synthetic'}}"));
        assertFalse(requests.complete(request, 200));
    }
}
