package com.faceclaw.sdk;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Generated typed declaration builder; ExtensionContract remains authoritative. */
public final class ExtensionDeclarations {
    public enum Feature {
        FEATURE_UI_LAUNCHER("ui.launcher"),
        FEATURE_UI_NAVIGATION("ui.navigation"),
        FEATURE_UI_APP_MENU("ui.app-menu"),
        FEATURE_UI_WINDOW_LAYOUT("ui.window-layout"),
        FEATURE_UI_TYPOGRAPHY("ui.typography"),
        FEATURE_UI_NOTIFICATIONS("ui.notifications"),
        FEATURE_ASSISTANT("assistant"),
        FEATURE_TRANSCRIPTION("transcription"),
        FEATURE_REFINEMENT("refinement"),
        FEATURE_DEVICE_TOOLS("device-tools"),
        FEATURE_NOTIFICATION_CONTENT("notification-content");
        public final String id;
        Feature(String id) { this.id = id; }
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private final JSONArray declarations = new JSONArray();

        public Builder add(Feature feature, boolean enabled) {
            return add(feature, enabled, new JSONObject());
        }

        public Builder add(Feature feature, boolean enabled, JSONObject configuration, Feature... requires) {
            if (feature == null || configuration == null) throw new IllegalArgumentException("feature and configuration required");
            try {
                JSONObject item = new JSONObject();
                item.put("feature", feature.id);
                item.put("enabled", enabled);
                item.put("configuration", configuration);
                JSONArray dependencies = new JSONArray();
                if (requires != null) for (Feature dependency : requires) {
                    if (dependency == null) throw new IllegalArgumentException("null dependency");
                    dependencies.put(dependency.id);
                }
                if (dependencies.length() > 0) item.put("requires", dependencies);
                declarations.put(item);
                return this;
            } catch (JSONException error) {
                throw new IllegalArgumentException("Unable to build extension declaration", error);
            }
        }

        public JSONArray build() {
            try { return ExtensionContract.declarations(new JSONArray(declarations.toString())); }
            catch (JSONException error) { throw new IllegalArgumentException("Invalid extension declarations", error); }
        }
    }

    private ExtensionDeclarations() {}
}
