package com.faceclaw.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.faceclaw.sdk.ExtensionContract;
import com.faceclaw.sdk.Protocol;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONArray;

/** Synthetic registry state only; verifies admission before persistent mutation. */
public final class SnapshotBudgetChecks {
    private static void check(boolean condition) { if (!condition) throw new AssertionError("Snapshot budget invariant"); }
    public static void run(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences("snapshot-budget-fixture", 0);
        prefs.edit().clear().commit();
        Map<String, String> owners = new TreeMap<>();
        FaceclawExtensions registry = new FaceclawExtensions(prefs, new FaceclawExtensions.Owners() {
            public Map<String, String> approved() { return owners; }
            public boolean connected(String component) { return true; }
            public boolean compatible(String component) { return true; }
        });
        JSONArray bundle = new JSONArray();
        for (String feature : ExtensionContract.FEATURES)
            bundle.put(Protocol.object("feature", feature, "enabled", true, "configuration", Protocol.object()));
        try {
            for (int i = 0; i < 9; i++) {
                String component = "example" + i + "/Service";
                owners.put(component, "synthetic"); registry.changed();
                check(registry.publish(component, bundle));
            }
            check(registry.snapshot().toString().length() < Protocol.MAX_JSON);
            boolean refused = false;
            for (int i = 0; i < 30; i++) {
                String component = "example/" + new String(new char[450]).replace('\0', 'x') + i;
                owners.put(component, "synthetic"); registry.changed();
                String before = registry.snapshot().toString();
                if (!registry.publish(component, bundle)) {
                    check("snapshot-capacity".equals(registry.publicationRejection()));
                    check(before.equals(registry.snapshot().toString()));
                    check(!prefs.contains(component + ":extensions"));
                    refused = true; break;
                }
            }
            check(refused);
            // A full registry can still withdraw a declaration and release snapshot space.
            check(registry.publish("example0/Service", new JSONArray()));
            for (String owner : owners.keySet()) for (String feature : ExtensionContract.FEATURES)
                registry.grant(owner, feature, true);
            check(registry.snapshot().toString().length() <= Protocol.MAX_JSON);
        } finally { prefs.edit().clear().commit(); }
    }
}
