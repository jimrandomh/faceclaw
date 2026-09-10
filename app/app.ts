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

Application.run({ moduleName: 'app-root' })

// Don't place any code after the application has been started
