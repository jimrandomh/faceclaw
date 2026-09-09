package com.faceclaw.sdk;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Immutable app-facing events. Decoding is not authentication or permission to act. */
public abstract class HostEvent {
    public final String type;
    private final String encoded;

    private HostEvent(String type, JSONObject data) {
        this.type = type;
        this.encoded = data.toString();
    }

    /** Escape hatch for legacy/future fields. Returns a copy; never log event payloads. */
    public final JSONObject data() {
        try { return new JSONObject(encoded); }
        catch (Exception error) { throw new IllegalStateException("Invalid event snapshot"); }
    }

    /** Does not include user content, request IDs, tokens or provider identities. */
    @Override public final String toString() { return "HostEvent(" + getClass().getSimpleName() + ")"; }

    /** Also usable by consumer tests to replay synthetic events, without an Android service. */
    public static HostEvent decode(String type, JSONObject supplied) {
        if (type == null || type.length() > 128 || supplied == null || supplied.toString().length() > 65536)
            throw new IllegalArgumentException("Invalid event envelope");
        JSONObject data;
        try { data = new JSONObject(supplied.toString()); }
        catch (Exception error) { throw new IllegalArgumentException("Invalid event envelope"); }
        try {
            switch (type) {
                case "open": case "resize": return new Window(type, data);
                case "visibility": return new Visibility(data);
                case "input": return new Input(data);
                case "capabilities": return new Capabilities(data);
                case "extensions": return new Extensions(data);
                case "extension-surface": return new Surface(data);
                case "extension-event": return new Provider(data);
                case "shared-style": return new Style(data);
                case "configure": return new Configure(data);
                case "notification-reply": return new NotificationReply(data);
                case "capture-dictation-status": case "capture-dictation-closed": return new CaptureStatus(type, data);
                case "dictation-result": case "search-dictation-result":
                case "host-refinement-result": case "capture-dictation-transcript": return new TextResult(type, data);
                case "dictation-rejected": case "search-dictation-rejected":
                case "host-refinement-rejected": return new Rejected(type, data);
                case "render": case "close": case "app-menu": return new Signal(type, data);
                default: return new Unknown(type, data);
            }
        } catch (IllegalArgumentException error) {
            // Legacy callbacks retain the original event; typed consumers never see a coerced shape.
            return new Unknown(type, data);
        }
    }

    public static final class Unknown extends HostEvent {
        private Unknown(String type, JSONObject data) { super(type, data); }
    }
    public static final class Signal extends HostEvent {
        private Signal(String type, JSONObject data) { super(type, data); }
    }
    public static final class Window extends HostEvent {
        public final int width, height;
        public final long generation;
        public final String target;
        private Window(String type, JSONObject data) {
            super(type, data);
            width = (int) number(data, "width", 1, 640);
            height = (int) number(data, "height", 1, 480);
            generation = number(data, "generation", 0, Long.MAX_VALUE);
            target = optionalString(data, "target");
        }
        public boolean isOpen() { return type.equals("open"); }
    }
    public static final class Visibility extends HostEvent {
        public final boolean visible, screenOn;
        private Visibility(JSONObject data) {
            super("visibility", data); visible = bool(data, "visible"); screenOn = bool(data, "screenOn");
        }
    }
    public static final class Input extends HostEvent {
        public final String inputType, source;
        public final Integer x, y;
        private Input(JSONObject data) {
            super("input", data); inputType = string(data, "type"); source = optionalString(data, "source");
            x = data.has("x") ? (int) number(data, "x", 0, 639) : null;
            y = data.has("y") ? (int) number(data, "y", 0, 479) : null;
        }
        public boolean isClick() { return inputType.equals("click"); }
    }
    public static final class Capabilities extends HostEvent {
        public final boolean notifications, dictation, previews, notificationReplies, searchDictation, windowMenus;
        public final int maxWidth, maxHeight, maxText, maxNotificationText, extensionSemantics;
        public final String extensionCompatibility;
        private Capabilities(JSONObject data) {
            super("capabilities", data);
            notifications = granted(data, "notifications"); dictation = granted(data, "dictation");
            previews = granted(data, "previews"); notificationReplies = granted(data, "notificationReplies");
            searchDictation = granted(data, "searchDictation"); windowMenus = granted(data, "windowMenus");
            maxWidth = limit(data, "maxWidth"); maxHeight = limit(data, "maxHeight");
            maxText = limit(data, "maxText"); maxNotificationText = limit(data, "maxNotificationText");
            extensionSemantics = limit(data, "extensionSemantics");
            extensionCompatibility = optionalString(data, "extensionCompatibility");
        }
    }
    public static final class Feature {
        public final String feature, component;
        public final long generation;
        public final boolean available, live;
        private final String configuration;
        private Feature(JSONObject data) {
            feature = string(data, "feature"); component = string(data, "component");
            generation = number(data, "generation", 0, Long.MAX_VALUE);
            available = bool(data, "available"); live = bool(data, "live");
            configuration = object(data, "configuration").toString();
        }
        public JSONObject configuration() {
            try { return new JSONObject(configuration); }
            catch (Exception error) { throw new IllegalStateException("Invalid configuration snapshot"); }
        }
    }
    public static final class Extensions extends HostEvent {
        /** Complete snapshot revision, NOT a feature's authority epoch. */
        public final long revision;
        public final List<Feature> features;
        private Extensions(JSONObject data) {
            super("extensions", data); revision = number(data, "generation", 0, Long.MAX_VALUE);
            JSONArray values = data.optJSONArray("features");
            if (values == null || values.length() > 64) throw new IllegalArgumentException();
            List<Feature> parsed = new ArrayList<>();
            for (int i = 0; i < values.length(); i++) {
                JSONObject value = values.optJSONObject(i);
                if (value == null) throw new IllegalArgumentException();
                parsed.add(new Feature(value));
            }
            features = Collections.unmodifiableList(parsed);
        }
        public Feature feature(String id) {
            for (Feature feature : features) if (feature.feature.equals(id)) return feature;
            return null;
        }
    }
    public static final class Surface extends HostEvent {
        public final String feature, phase;
        public final long generation;
        /** Present on open/resize only. Never substitute the surface generation for this epoch. */
        public final Long extensionGeneration;
        public final Integer width, height;
        public final boolean visible, screenOn;
        private Surface(JSONObject data) {
            super("extension-surface", data); feature = string(data, "feature"); phase = string(data, "type");
            generation = number(data, "generation", 0, Long.MAX_VALUE);
            boolean opening = phase.equals("open") || phase.equals("resize");
            width = opening ? (int) number(data, "width", 1, 640) : null;
            height = opening ? (int) number(data, "height", 1, 480) : null;
            extensionGeneration = opening ? number(data, "extensionGeneration", 0, Long.MAX_VALUE) : null;
            visible = granted(data, "visible"); screenOn = granted(data, "screenOn");
        }
    }
    /** Common provider envelope, including assistant/refinement/transcription request fields. */
    public static final class Provider extends HostEvent {
        public final String feature, phase, requestId, operation, text, original, followup, reason, callId, status;
        public final String event, error, format, captureId, pcmBase64;
        public final boolean ok, ownCapture;
        public final Integer sampleRate, maxBytes;
        public final long generation;
        /** Host deadline in epoch milliseconds; absent for non-request events. */
        public final Long deadlineAt;
        private final String payload;
        private Provider(JSONObject data) {
            super("extension-event", data); feature = string(data, "feature"); phase = string(data, "type");
            generation = number(data, "generation", 0, Long.MAX_VALUE);
            JSONObject body = object(data, "data"); payload = body.toString();
            requestId = optionalString(body, "requestId");
            deadlineAt = body.has("deadlineAt") ? number(body, "deadlineAt", 0, Long.MAX_VALUE) : null;
            if (phase.equals("request") && (requestId.isEmpty() || deadlineAt == null)) throw new IllegalArgumentException();
            operation = optionalString(body, "operation"); text = optionalString(body, "text");
            original = optionalString(body, "original"); followup = optionalString(body, "followup");
            reason = optionalString(body, "reason"); callId = optionalString(body, "callId");
            status = optionalString(body, "status");
            event = optionalString(body, "event"); error = optionalString(body, "error");
            format = optionalString(body, "format"); captureId = optionalString(body, "captureId");
            pcmBase64 = optionalString(body, "pcmBase64");
            ok = granted(body, "ok"); ownCapture = feature.equals("transcription") && granted(body, "ownCapture");
            sampleRate = optionalInt(body, "sampleRate"); maxBytes = optionalInt(body, "maxBytes");
        }
        public boolean isRequest() { return phase.equals("request"); }
        public boolean isCancellation() { return phase.equals("cancel"); }
        public boolean isExpired(long nowMillis) { return deadlineAt != null && nowMillis >= deadlineAt; }
        /** Feature-specific tools, audio chunks and notification fragments remain extensible. */
        public JSONObject payload() {
            try { return new JSONObject(payload); }
            catch (Exception error) { throw new IllegalStateException("Invalid provider snapshot"); }
        }
    }
    public static final class Style extends HostEvent {
        public final String font, raster;
        public final Integer size, borderWidth, selectionBorderWidth, cardRadius;
        private Style(JSONObject data) {
            super("shared-style", data); font = optionalString(data, "font"); raster = optionalString(data, "raster");
            size = optionalInt(data, "size"); borderWidth = optionalInt(data, "borderWidth");
            selectionBorderWidth = optionalInt(data, "selectionBorderWidth"); cardRadius = optionalInt(data, "cardRadius");
        }
    }
    public enum TextPurpose { MESSAGE_REVIEW, SEARCH, REFINEMENT, CAPTURE }
    public static final class Configure extends HostEvent {
        public final String endpoint, code;
        private Configure(JSONObject data) {
            super("configure", data); endpoint = string(data, "endpoint"); code = string(data, "code");
        }
    }
    /** The SDK has already consumed the current token; the app must still recheck its destination/account. */
    public static final class NotificationReply extends HostEvent {
        public final String id, target, replyToken, text;
        public final boolean confirmed;
        private NotificationReply(JSONObject data) {
            super("notification-reply", data); id = string(data, "id"); target = string(data, "target");
            replyToken = string(data, "replyToken"); text = string(data, "text"); confirmed = bool(data, "confirmed");
        }
    }
    public static final class CaptureStatus extends HostEvent {
        public final String requestId, status, reason;
        private CaptureStatus(String type, JSONObject data) {
            super(type, data); requestId = string(data, "requestId");
            status = optionalString(data, "status"); reason = optionalString(data, "reason");
        }
    }
    public static final class TextResult extends HostEvent {
        public final TextPurpose purpose;
        public final String requestId, target, text;
        public final boolean confirmed, isFinal;
        private TextResult(String type, JSONObject data) {
            super(type, data); requestId = string(data, "requestId"); text = string(data, "text");
            target = optionalString(data, "target"); confirmed = granted(data, "confirmed");
            isFinal = granted(data, "isFinal");
            purpose = type.equals("dictation-result") ? TextPurpose.MESSAGE_REVIEW : type.equals("search-dictation-result")
                ? TextPurpose.SEARCH : type.equals("host-refinement-result") ? TextPurpose.REFINEMENT : TextPurpose.CAPTURE;
        }
    }
    public static final class Rejected extends HostEvent {
        public final String requestId, reason;
        private Rejected(String type, JSONObject data) {
            super(type, data); requestId = string(data, "requestId"); reason = string(data, "reason");
        }
    }

    private static String string(JSONObject data, String key) {
        Object value = data.opt(key);
        if (!(value instanceof String)) throw new IllegalArgumentException();
        return (String) value;
    }
    private static String optionalString(JSONObject data, String key) { return data.has(key) ? string(data, key) : ""; }
    private static boolean bool(JSONObject data, String key) {
        Object value = data.opt(key);
        if (!(value instanceof Boolean)) throw new IllegalArgumentException();
        return (Boolean) value;
    }
    private static boolean granted(JSONObject data, String key) { return Boolean.TRUE.equals(data.opt(key)); }
    private static long number(JSONObject data, String key, long minimum, long maximum) {
        Object value = data.opt(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException();
        double number = ((Number) value).doubleValue();
        long result = ((Number) value).longValue();
        if (Double.isNaN(number) || Double.isInfinite(number) || number != result || result < minimum || result > maximum)
            throw new IllegalArgumentException();
        return result;
    }
    private static int limit(JSONObject data, String key) { return data.has(key) ? (int) number(data, key, 0, Integer.MAX_VALUE) : 0; }
    private static Integer optionalInt(JSONObject data, String key) { return data.has(key) ? limit(data, key) : null; }
    private static JSONObject object(JSONObject data, String key) {
        JSONObject value = data.optJSONObject(key);
        if (value == null) throw new IllegalArgumentException();
        return value;
    }
}
