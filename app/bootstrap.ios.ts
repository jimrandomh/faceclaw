import { Application } from '@nativescript/core'
import { createMainPage } from './phone-ui/main-page.ios'

Application.run({ create: createMainPage })
