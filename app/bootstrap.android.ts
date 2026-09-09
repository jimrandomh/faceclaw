import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'
import { registerPhoneRotation } from './native/phone-rotation'

installNativeUserAgent()
registerShareIntentHandler()
registerPhoneRotation()

Application.run({ moduleName: 'app-root' })
