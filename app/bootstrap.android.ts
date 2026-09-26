import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'
import { registerPhoneRotation } from './native/phone-rotation'
import { startLiveHealthSync, startAlignedRingPull } from './health/health-live'

import { runKotlinBridgeSmokeTest } from './native/kotlin-bridge'

declare const __DEV__: boolean;

if (__DEV__) runKotlinBridgeSmokeTest()

installNativeUserAgent()
registerShareIntentHandler()
registerPhoneRotation()

// Ring health records live only in the communicator's memory until something
// stores them. Both health surfaces store on open, but a pull that lands while
// they are closed would be lost if the process restarted first, so this keeps
// them reaching disk regardless. No-op when there is nothing new.
startLiveHealthSync()

// Collect from the ring on a wall-clock cadence (:01 and :31). Without this
// nothing drives a pull on a timer at all - only onRingReady() on reconnect -
// so a ring that stays connected is never read.
startAlignedRingPull()

Application.run({ moduleName: 'app-root' })
