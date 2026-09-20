import { Application, Frame } from '@nativescript/core'
import { runKotlinBridgeSmokeTest } from './native/kotlin-bridge'
declare const FaceclawConfigPort: any
declare const __DEV__: boolean;

if (__DEV__) runKotlinBridgeSmokeTest()

// Apply transferred preferences before settings getters or app workers load.
FaceclawConfigPort.processPendingRequest()
require('./phone-ui/onboarding-register.ios')
const { hasCompletedOnboarding } = require('./phone-ui/onboarding-state') as typeof import('./phone-ui/onboarding-state')
Application.run({ create: () => {
  const frame = new Frame()
  frame.navigate({ moduleName: hasCompletedOnboarding() ? 'phone-ui/main-page' : 'phone-ui/onboarding-page' })
  return frame
} })
