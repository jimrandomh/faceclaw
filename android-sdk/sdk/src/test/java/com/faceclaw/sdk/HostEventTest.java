package com.faceclaw.sdk;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class HostEventTest {
    private HostEvent event(String type, String json) throws Exception { return HostEvent.decode(type, new JSONObject(json)); }
    @Test public void lifecycleReplayRequiresVisibleAwakeWindowAndClearsOnDisconnect() throws Exception {
        WindowState window = new WindowState();
        window.accept(event("open", "{width:320,height:120,generation:2}"));
        assertFalse(window.canDraw());
        window.accept(event("visibility", "{visible:true,screenOn:true}"));
        assertTrue(window.canDraw());
        window.accept(event("resize", "{width:160,height:80,generation:3}"));
        assertTrue(window.canDraw()); assertEquals(160, window.width()); assertEquals(3, window.generation());
        window.accept(event("visibility", "{visible:true,screenOn:false}"));
        assertFalse(window.canDraw());
        window.accept(event("visibility", "{visible:true,screenOn:true}"));
        window.accept(event("close", "{}"));
        assertFalse(window.canDraw());
        window.accept(event("open", "{width:32,height:16,generation:4}"));
        assertFalse(window.canDraw());
        window.accept(event("visibility", "{visible:true,screenOn:true}"));
        window.disconnect(); assertFalse(window.canDraw()); assertEquals(0, window.width());
    }
    @Test public void malformedShapesNeverCoerceIntoTypedAuthority() throws Exception {
        assertTrue(event("open", "{width:641,height:16,generation:1}") instanceof HostEvent.Unknown);
        assertTrue(event("resize", "{width:'32',height:16,generation:1}") instanceof HostEvent.Unknown);
        assertTrue(event("visibility", "{visible:'true',screenOn:true}") instanceof HostEvent.Unknown);
        HostEvent.Capabilities capabilities = (HostEvent.Capabilities) event("capabilities", "{dictation:'true'}");
        assertFalse(capabilities.dictation); assertFalse(capabilities.notifications);
        assertTrue(event("extension-event", "{feature:'assistant',generation:1,type:'request',data:{requestId:'x'}}") instanceof HostEvent.Unknown);
    }
    @Test public void snapshotsAreImmutableAndDiagnosticsDoNotPrintPayloads() throws Exception {
        JSONObject data = new JSONObject("{width:32,height:16,generation:1,target:'PRIVATE'}");
        HostEvent.Window window = (HostEvent.Window) HostEvent.decode("open", data);
        data.put("target", "changed"); window.data().put("target", "changed-again");
        assertEquals("PRIVATE", window.target); assertEquals("PRIVATE", window.data().getString("target"));
        assertFalse(window.toString().contains("PRIVATE"));
        HostEvent future = event("future-event", "{secret:'PRIVATE'}");
        assertTrue(future instanceof HostEvent.Unknown); assertFalse(future.toString().contains("PRIVATE"));
        assertEquals("PRIVATE", future.data().getString("secret"));
    }
    @Test public void reviewedSearchAndDraftPurposesRemainDistinct() throws Exception {
        HostEvent.TextResult search = (HostEvent.TextResult) event("search-dictation-result", "{requestId:'s',target:'directory',text:'Alice',confirmed:true}");
        assertEquals(HostEvent.TextPurpose.SEARCH, search.purpose);
        HostEvent.TextResult draft = (HostEvent.TextResult) event("capture-dictation-transcript", "{requestId:'d',text:'Alice',isFinal:true,purpose:'capture'}");
        assertEquals(HostEvent.TextPurpose.CAPTURE, draft.purpose); assertFalse(draft.confirmed);
        HostEvent.TextResult review = (HostEvent.TextResult) event("dictation-result", "{requestId:'r',target:'conversation',text:'Hello',confirmed:true}");
        assertEquals(HostEvent.TextPurpose.MESSAGE_REVIEW, review.purpose); assertTrue(review.confirmed);
    }
    private HostEvent.Provider request(long epoch, String id, long deadline) throws Exception {
        return (HostEvent.Provider) event("extension-event", "{feature:'assistant',generation:" + epoch + ",type:'request',data:{requestId:'" + id + "',text:'PRIVATE',deadlineAt:" + deadline + "}}");
    }
    private HostEvent.Extensions snapshot(long revision, long epoch, boolean available) throws Exception {
        return (HostEvent.Extensions) event("extensions", "{generation:" + revision + ",features:[{feature:'assistant',component:'example/.Service',generation:" + epoch + ",available:" + available + ",live:true,configuration:{}}]}");
    }
    @Test public void featureEpochIsNotSnapshotRevisionAndUnrelatedUpdatesPreserveWork() throws Exception {
        ProviderRequests requests = new ProviderRequests(); HostEvent.Provider request = request(7, "r", 500);
        assertTrue(requests.begin(request, 100)); assertFalse(requests.begin(request, 100));
        HostEvent.Extensions update = snapshot(90, 7, true);
        assertEquals(90, update.revision); assertEquals(7, update.feature("assistant").generation);
        requests.accept(update); assertTrue(requests.complete(request, 200)); assertFalse(requests.complete(request, 200));
        try { update.features.clear(); fail("Mutable features"); } catch (UnsupportedOperationException expected) {}
    }
    @Test public void replacementCancellationExpiryAndDisconnectRejectLateResults() throws Exception {
        ProviderRequests requests = new ProviderRequests(); HostEvent.Provider request = request(7, "r", 500);
        requests.begin(request, 100); requests.accept(snapshot(91, 8, true)); assertFalse(requests.complete(request, 200));
        requests.begin(request, 100); requests.accept(snapshot(92, 7, false)); assertFalse(requests.complete(request, 200));
        requests.begin(request, 100);
        requests.accept(event("extension-event", "{feature:'assistant',generation:7,type:'cancel',data:{requestId:'r',reason:'deadline'}}"));
        assertFalse(requests.complete(request, 200));
        requests.begin(request, 100); assertFalse(requests.complete(request, 500));
        assertFalse(requests.begin(request, 501));
        requests.begin(request, 100); requests.disconnect();
        HostEvent.Provider nextSession = request(7, "r", 500);
        assertTrue(requests.begin(nextSession, 100)); assertFalse(requests.complete(request, 200));
        assertTrue(requests.complete(nextSession, 200));
    }
    @Test public void providerResultsDoNotClaimSafeRetryForUnknownDispatch() throws Exception {
        assertTrue(ProviderResult.unknownOutcome().data().getBoolean("dispatched"));
        assertFalse(ProviderResult.unavailableBeforeDispatch().data().getBoolean("dispatched"));
        assertEquals("", ProviderResult.success("").data().getString("text"));
        assertFalse(ProviderResult.success("PRIVATE").toString().contains("PRIVATE"));
    }
    @Test public void surfaceEpochIsOnlyPresentWhenSuppliedByHost() throws Exception {
        HostEvent.Surface opened = (HostEvent.Surface) event("extension-surface", "{feature:'ui.launcher',type:'open',width:32,height:16,generation:20,extensionGeneration:7}");
        assertEquals(Long.valueOf(7), opened.extensionGeneration); assertEquals(20, opened.generation);
        HostEvent.Surface closed = (HostEvent.Surface) event("extension-surface", "{feature:'ui.launcher',type:'close',generation:20}");
        assertNull(closed.extensionGeneration); assertNull(closed.width);
    }
    @Test public void ownTranscriptionDoesNotRequireGlobalSelection() throws Exception {
        ProviderRequests requests = new ProviderRequests();
        HostEvent.Provider capture = (HostEvent.Provider) event("extension-event", "{feature:'transcription',generation:4,type:'request',data:{requestId:'capture',deadlineAt:500,ownCapture:true,captureId:'draft',sampleRate:16000,format:'pcm_s16le',maxBytes:9600000}}");
        assertTrue(capture.ownCapture); assertEquals(Integer.valueOf(16000), capture.sampleRate);
        assertTrue(requests.begin(capture, 100));
        requests.accept(event("extensions", "{generation:90,features:[{feature:'transcription',component:'',generation:4,available:false,live:true,configuration:{}}]}"));
        assertTrue(requests.complete(capture, 200));
    }
    @Test public void setupAndNotificationReplyStayPrivateAndSeparateFromDrafts() throws Exception {
        HostEvent.Configure configure = (HostEvent.Configure) event("configure", "{endpoint:'https://example.invalid',code:'PRIVATE'}");
        assertEquals("PRIVATE", configure.code); assertFalse(configure.toString().contains("PRIVATE"));
        HostEvent.NotificationReply reply = (HostEvent.NotificationReply) event("notification-reply", "{id:'n',target:'conversation',replyToken:'PRIVATE',text:'Message',confirmed:true}");
        assertTrue(reply.confirmed); assertFalse(reply.toString().contains("PRIVATE"));
        assertTrue(event("notification-reply", "{id:'n',target:'x',replyToken:'x',text:'x',confirmed:'true'}") instanceof HostEvent.Unknown);
    }
}
