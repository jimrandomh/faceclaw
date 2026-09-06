import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'

installNativeUserAgent()
registerShareIntentHandler()

Application.run({ moduleName: 'app-root' })
