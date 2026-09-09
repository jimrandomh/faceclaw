package com.faceclaw.sdk.fixture;
/** Test-only peer with an incompatible extension revision and valid ordinary v1 windows. */
public final class LegacyService extends AdversarialService {
 @Override protected int extensionSemantics() { return 0; }
}
