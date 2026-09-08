import { Application } from '@nativescript/core'
declare const FaceclawConfigPort: any

// Apply transferred preferences before settings getters or app workers load.
FaceclawConfigPort.processPendingRequest()
const { createMainPage } = require('./phone-ui/main-page.ios') as typeof import('./phone-ui/main-page.ios')

Application.run({ create: createMainPage })
