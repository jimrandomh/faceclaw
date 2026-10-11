import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'
import { registerPhoneRotation } from './native/phone-rotation'

installNativeUserAgent()
registerShareIntentHandler()
registerPhoneRotation()
// Opt-in analytics (app/analytics/), started once the app is up rather than
// loading its imports on the boot path.
Application.on(Application.launchEvent, () => {
  setTimeout(() => require('./analytics/analytics-sources').startAppAnalytics(), 0)
})

Application.run({ moduleName: 'app-root' })
