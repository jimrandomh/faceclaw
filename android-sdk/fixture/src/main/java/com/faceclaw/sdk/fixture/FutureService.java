package com.faceclaw.sdk.fixture;
/** Test-only peer with an incompatible extension revision and valid ordinary v1 windows. */
public final class FutureService extends AdversarialService {
 @Override protected int extensionSemantics() { return 3; }
}
