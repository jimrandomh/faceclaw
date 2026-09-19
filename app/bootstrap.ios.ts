import { Application } from '@nativescript/core'
import { runKotlinBridgeSmokeTest } from './native/kotlin-bridge'
declare const FaceclawConfigPort: any
declare const __DEV__: boolean;

if (__DEV__) runKotlinBridgeSmokeTest()

// Apply transferred preferences before settings getters or app workers load.
FaceclawConfigPort.processPendingRequest()
const { createMainPage } = require('./phone-ui/main-page.ios') as typeof import('./phone-ui/main-page.ios')

Application.run({ create: createMainPage })
