/**
 * iOS side of watch-app-install.ts: whether the paired Apple Watch has the
 * Faceclaw app (WatchConnectivity, through FaceclawWatchBridge), and where to
 * send the user to install it. iOS has no call that installs a watch app; the
 * system does it from the iPhone's Watch app, or from TestFlight for a beta.
 */
import { Application } from '@nativescript/core'
import { buildKind } from './build-info'
import type { WatchAppHandover, WatchAppInstall, WatchAppInstallSource, WatchAppInstallState } from './watch-app-install'

declare const FaceclawWatchBridge: any
declare const NSBundle: any
declare const NSDictionary: any
declare const NSURL: any
declare const UIApplication: any
declare const UIApplicationState: any

/**
 * The iPhone's Watch app, which opens on My Watch. This is the one URL scheme
 * it registers that other apps may open (its Info.plist, iOS 26.4 and 27.2).
 */
const WATCH_APP_URL = 'itms-watchs://'
/** The TestFlight app, which opens on its list of apps. */
const TESTFLIGHT_URL = 'itms-beta://'
/**
 * How long an opening asked for with Faceclaw in the background waits for it
 * to come to the front. Long enough to get the phone out; short enough that
 * opening Faceclaw later for something else doesn't jump to another app.
 */
const HANDOVER_WAIT_MS = 2 * 60 * 1000
/** A TestFlight install's App Store receipt has this file name; an App Store install's is "receipt". */
const TESTFLIGHT_RECEIPT_NAME = 'sandboxReceipt'

const SOURCE_URLS: Record<WatchAppInstallSource, string> = { 'watch-app': WATCH_APP_URL, testflight: TESTFLIGHT_URL }

/** What FaceclawWatchBridge.m's watchAppInstallState can return. */
const STATES: readonly WatchAppInstallState[] = ['unknown', 'no-watch', 'not-installed', 'installed']

class IosWatchAppInstall implements WatchAppInstall {
  private nativeBridge: any = undefined
  private listening = false
  private readonly listeners = new Set<() => void>()
  /** When an opening that is waiting for Faceclaw to come to the front lapses; 0 with none waiting. */
  private waitingUntil = 0
  private watchingResume = false

  private native(): any {
    if (this.nativeBridge !== undefined) return this.nativeBridge
    try {
      const bridge = FaceclawWatchBridge.shared()
      this.nativeBridge = bridge.isAvailable() ? bridge : null
    } catch (error) {
      console.warn('watch bridge unavailable', error)
      this.nativeBridge = null
    }
    return this.nativeBridge
  }

  getState(): WatchAppInstallState {
    const state = String(this.native()?.watchAppInstallState() ?? '') as WatchAppInstallState
    return STATES.includes(state) ? state : 'unknown'
  }

  getSource(): WatchAppInstallSource | null {
    // Apple delivers a release's watch app itself, so the bundle says nothing
    // about it; a build from Xcode can only offer the copy embedded in it.
    if (buildKind() === 'official') return installedByTestFlight() ? 'testflight' : 'watch-app'
    return this.native()?.bundlesWatchApp() ? 'watch-app' : null
  }

  onStateChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    if (!this.listening) {
      this.listening = true
      this.native()?.setInstallStateHandler(() => {
        for (const each of Array.from(this.listeners)) {
          try { each() }
          catch (error) { console.warn('watch install listener failed', error) }
        }
      })
    }
    return () => { this.listeners.delete(listener) }
  }

  openSource(): Promise<boolean> {
    const source = this.getSource()
    if (!source) return Promise.resolve(false)
    return new Promise(resolve => {
      try {
        // Not Utils.openUrl: it asks canOpenURL first, which refuses any scheme
        // that Info.plist doesn't list, though opening one needs no such entry.
        UIApplication.sharedApplication.openURLOptionsCompletionHandler(
          NSURL.URLWithString(SOURCE_URLS[source]), NSDictionary.dictionary(), (opened: boolean) => resolve(Boolean(opened)))
      } catch (error) {
        console.warn('could not open the watch app installer', error)
        resolve(false)
      }
    })
  }

  openSourceWhenInFront(): Promise<WatchAppHandover> {
    if (!this.getSource()) return Promise.resolve('failed')
    if (UIApplication.sharedApplication.applicationState === UIApplicationState.Active) {
      return this.openSource().then(opened => (opened ? 'opened' : 'failed'))
    }
    this.waitingUntil = Date.now() + HANDOVER_WAIT_MS
    if (!this.watchingResume) {
      this.watchingResume = true
      Application.on(Application.resumeEvent, () => this.openIfWaiting())
    }
    return Promise.resolve('waiting')
  }

  /** Faceclaw came to the front: finish an opening that was waiting for that, unless it lapsed or the watch got the app meanwhile. */
  private openIfWaiting(): void {
    const until = this.waitingUntil
    this.waitingUntil = 0
    if (Date.now() <= until && this.getState() === 'not-installed') void this.openSource()
  }
}

function installedByTestFlight(): boolean {
  return String(NSBundle.mainBundle.appStoreReceiptURL?.lastPathComponent ?? '') === TESTFLIGHT_RECEIPT_NAME
}

export const watchAppInstall: WatchAppInstall = new IosWatchAppInstall()
