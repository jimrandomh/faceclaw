import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'
import { registerPhoneRotation } from './native/phone-rotation'
import { startLiveHealthSync, startAlignedRingPull } from './health/health-live'

installNativeUserAgent()
registerShareIntentHandler()
registerPhoneRotation()
// Opt-in analytics (app/analytics/), started once the app is up rather than
// loading its imports on the boot path.
Application.on(Application.launchEvent, () => {
  setTimeout(() => require('./analytics/analytics-sources').startAppAnalytics(), 0)
})

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
