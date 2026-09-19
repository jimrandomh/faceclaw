import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'
import { registerPhoneRotation } from './native/phone-rotation'

import { runKotlinBridgeSmokeTest } from './native/kotlin-bridge'

declare const __DEV__: boolean;

if (__DEV__) runKotlinBridgeSmokeTest()

installNativeUserAgent()
registerShareIntentHandler()
registerPhoneRotation()

Application.run({ moduleName: 'app-root' })
