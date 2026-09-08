import { Utils } from '@nativescript/core'
/** Open outside the app runtime; this page has no EvenHub bridge. */
export function openPrivacyPolicyOnPhone(url: string, _appName: string): void {
  if (/^https:\/\//i.test(url)) Utils.openUrl(url)
}
