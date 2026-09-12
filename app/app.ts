/*
In NativeScript, the app.ts file is the entry point to your application.
You can use this file to perform app-level initialization, but the primary
purpose of the file is to pass control to the app’s first module.
*/

import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'
import { registerPhoneRotation } from './native/phone-rotation'

installNativeUserAgent()
registerShareIntentHandler()
registerPhoneRotation()

import { resyncSystemAppearance } from './native/system-appearance'
import { startLiveHealthSync, startAlignedRingPull } from './health/health-live'

installNativeUserAgent()
registerShareIntentHandler()

// Ring health records live only in the communicator's memory until something
// stores them. Both health surfaces store on open, but a pull that lands while
// they are closed would be lost if the process restarted first, so this keeps
// them reaching disk regardless. No-op when there is nothing new.
startLiveHealthSync()

// Collect from the ring on a wall-clock cadence (:01 and :31). Without this
// nothing drives a pull on a timer at all - only onRingReady() on reconnect -
// so a ring that stays connected is never read.
startAlignedRingPull()

// Live system dark/light switches while the app is running were confirmed
// (Chris, both directions, 2026-09-02) to leave the Ghost companion's Terminal
// and Doc panes white-on-white and Rich View visually dark-locked -- while a
// COLD launch in either theme renders correctly. That proves the app.css
// .ns-dark rules themselves are right and the LIVE-UPDATE signal is the gap,
// not any one pane's styling -- see system-appearance.ts for the actual fix
// and why it resyncs from two triggers instead of trusting the framework's
// own automatic recolor alone.
Application.on(Application.systemAppearanceChangedEvent, resyncSystemAppearance)
Application.on(Application.resumeEvent, resyncSystemAppearance)

Application.run({ moduleName: 'app-root' })

// Don't place any code after the application has been started
