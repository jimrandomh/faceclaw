import { Frame } from '@nativescript/core'

/** Return to the existing iOS controller after a devices/firmware detour. */
export function finishOnboardingNavigation(): void {
  const frame = Frame.topmost()
  const main = global.isIOS && frame?.backStack.find(entry => entry.entry.moduleName === 'phone-ui/main-page')
  if (main) frame.goBack(main)
  else frame?.navigate({ moduleName: 'phone-ui/main-page', clearHistory: true })
}
