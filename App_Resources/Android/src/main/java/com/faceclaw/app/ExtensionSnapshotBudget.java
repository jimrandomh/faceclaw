package com.faceclaw.app;

import com.faceclaw.sdk.ExtensionContract;
import com.faceclaw.sdk.Protocol;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bound the shared control message by its contents, not by an arbitrary app count. */
final class ExtensionSnapshotBudget {
    static boolean fits(Map<String, JSONArray> declarations) {
        JSONArray features = new JSONArray();
        for (String feature : ExtensionContract.FEATURES) {
            JSONArray contenders = new JSONArray();
            String longestOwner = "";
            JSONObject largestConfiguration = new JSONObject();
            for (Map.Entry<String, JSONArray> owner : declarations.entrySet()) {
                for (int index = 0; index < owner.getValue().length(); index++) {
                    JSONObject item = owner.getValue().optJSONObject(index);
                    if (!feature.equals(item.optString("feature"))) continue;
                    // false and dependency-unavailable are the longest encoded states.
                    contenders.put(Protocol.object("component", owner.getKey(), "enabled", false,
                            "granted", false, "connected", false, "reason", "dependency-unavailable",
                            "requires", item.optJSONArray("requires")));
                    if (JSONObject.quote(owner.getKey()).length() > JSONObject.quote(longestOwner).length())
                        longestOwner = owner.getKey();
                    JSONObject configuration = item.optJSONObject("configuration");
                    if (configuration.toString().length() > largestConfiguration.toString().length())
                        largestConfiguration = configuration;
                }
            }
            // Reserve enough space for any future winner, grant, connection state or epoch.
            features.put(Protocol.object("feature", feature, "component", longestOwner,
                    "configuration", largestConfiguration, "live", false, "available", false,
                    "generation", Long.MAX_VALUE, "contenders", contenders));
        }
        return Protocol.object("version", ExtensionContract.VERSION, "generation", Long.MAX_VALUE,
                "features", features).toString().length() <= Protocol.MAX_JSON;
    }

    private ExtensionSnapshotBudget() {}
}
