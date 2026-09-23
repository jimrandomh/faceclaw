import { startRemoteInput } from "../remote/service"
import type { KeyboardInputSession } from '../ui/shell/keyboard-input'
import { acceptInput, resetRingInputFilter } from "../ui/input-monitor";
import { bindIosNotifications, iosNotificationsChanged, onIosNotificationPopup } from '../native/notification-icons.ios'
import { shouldShowNotificationOnGlasses } from '../native/notification-sources'
import { readActiveNotifications } from '../native/notification-icons.ios'
import { launcherEntries } from '../apps/launcher'
import { getInstalledEvenHubAppById, installedEvenHubPackageId, uninstallEvenHubPackage } from '../apps/evenhub/installed-apps'
import { isInstalledPackagePresent } from '../apps/evenhub/updates'
import { openEvenHubStoreForPackage } from '../apps/evenhub'
import { launchInstalledPackage, closeRunningPackage } from '../apps/evenhub/manager'
import { registerSystemTools } from '../assistant/system-tools'
import { registerWindowTools } from '../assistant/window-tools'
import { registerNavigateTools } from '../assistant/navigate-tools'
import { registerRoamTools } from '../assistant/roam-tools'
import { IosNavigationSensors } from '../native/ios-navigation-sensors'
import { Utils } from '@nativescript/core'
import { bindCompassSession, receiveCompassEvent } from '../native/compass.ios'
import { Dialogs, File, knownFolders, path, type ImageSource } from '@nativescript/core'
import { iosVoiceInput } from '../native/ios-voice-input'
import { nightscoutBridge } from '../native/nightscout-bridge'
import { FaceclawCommunicatorBridge, resolveIosPeripherals, type CommunicatorState, type RawInputEvent } from '../native/faceclaw-communicator.ios'
import { PreviewDisplayTarget, type DisplayTarget } from '../native/preview-display.ios'
import { AncsClient, ANCS_FIRMWARE_VERSION } from './ancs-client'
import { GlanceHost, type GlanceDisplay } from './glance-host'
import { createLockScreenImage, LOCK_SCREEN_SURFACE_ID } from './lock-screen'
import { OsEventTypeList } from './events'
import { loadDeviceAddresses } from './device-addresses'
import { deviceAddressError } from './ios-peripheral-identity'
import { createLauncherWindow, LAUNCHER_SURFACE_ID } from '../apps/launcher/launcher-app'
import { ALL_APPS } from '../apps/all-apps'
import type { AppContext, AppDefinition, AppLaunchParams } from '../apps/app-definition'
import { WorkerAppHost } from '../ui/shell/worker-window'
import { createInProcessWindow, YieldAtRootLayer, type InProcessAppOptions, type InProcessWindow } from '../ui/shell/in-process-window'
import { getStringSettingById, nightscoutSiteUrlSetting, nightscoutApiTokenSetting } from '../ui/dashboard-settings'
import { readPhoneBatteryState } from '../native/phone-battery'
import { iosAppUnavailableReason } from '../apps/ios-availability'
import { flattenPlanesWithDraws, planesFingerprint, type Plane } from '../graphics/plane'
import { prepareFrameDraws } from '../graphics/glyph-wire'
import { G2_LENS_WIDTH, G2_LENS_HEIGHT } from '../graphics/image'
import { makeInputEvent, type InputEvent, type InputEventPayload } from '../ui/gestures'
import { noopLayerActions, type LayerActions } from '../ui/layers'
import { TextViewerLayer } from '../apps/files/text-viewer'
import { shell, rawInputEventToInputEvent, type ShellWindow } from '../ui/shell/shell'
import { appViewportRect, SIDEBAR_WIDTH, sidebarStripVisible } from '../ui/shell/geometry'
import { DISPLAY_MODE_VALUES, displayModeLabel, displayModeSetting, onAnySettingChanged,
  previewColorSetting, lockScreenEnabledSetting, brightnessSetting, brightnessSettingToLevel } from '../ui/dashboard-settings'
import type { PhoneGesture } from '../phone-ui/phone-gestures'
import { isWelcomeSoundPending, setWelcomeSoundPending } from '../phone-ui/onboarding-state'
import { findSoundEffect, playSoundEffect } from '../ui/sound-effects'

const SHELL_SURFACE_ID = 'shell'
const SHELL_SURFACE_Z_ORDER = 1
const LOCK_SURFACE_Z_ORDER = 1000
/** The shell render loop waits this long for the glasses to take a frame before moving on. */
const FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS = 2000

export type SessionPhase = 'disconnected' | 'connecting' | 'connected' | 'retrying' | 'disconnecting' | 'error'
export type SessionState = { phase: SessionPhase; status: string; battery: number | null; charging: boolean | null;
  ring: boolean; frames: number; capabilities: string; leftVersion: string; rightVersion: string }

function ancsCapable(capabilities: string): boolean {
  return /^Faceclaw\/(\d+)/.test(capabilities) && Number(capabilities.split('/')[1]) >= ANCS_FIRMWARE_VERSION
}

/**
 * iOS host for the shared app registry, shell and BLE session. The session,
 * compositor and transport live in shared Kotlin (FaceclawCommunicatorBridge
 * over FaceclawKitIosGlassesSession); with no glasses connected the same
 * compositor runs headless (PreviewDisplayTarget) so the phone mirror works.
 */
export class IosPreviewController {
  private previewTarget: PreviewDisplayTarget | null = null
  private communicator: FaceclawCommunicatorBridge | null = null
  private readonly startedCommunicators = new WeakSet<FaceclawCommunicatorBridge>()
  state: SessionState = { phase: 'disconnected', status: 'Preview only', battery: null, charging: null, ring: false,
    frames: 0, capabilities: '', leftVersion: '', rightVersion: '' }
  private notifications: AncsClient | null = null
  private readonly sessionOffs: (() => void)[] = []
  private stopping: Promise<void> | null = null
  /** Resolves once the current display target has every surface configured. */
  private displayReady: Promise<void> = Promise.resolve()
  private connecting = false
  private sessionCreated = false
  private wearDetectionRequested = false
  private readonly glanceDisplay: GlanceDisplay = {
    configureSurface: async (id, options) => { await this.display?.configureSurface(id, options) },
    setSurfaceVisible: async (id, visible) => { await this.display?.setSurfaceVisible(id, visible); this.schedulePreviewUpdate() },
    setScreenBlanked: async blanked => { await this.display?.setScreenBlanked(blanked); this.schedulePreviewUpdate() },
    submitSurfaceFrame: async (id, pixels, rect, fingerprint, paintMs, frameId, draws) => {
      await this.display?.submitSurfaceFrame(id, pixels, rect, fingerprint, paintMs, frameId, draws); this.schedulePreviewUpdate()
    },
  }
  private readonly glance = new GlanceHost({
    getDisplay: () => this.display ? this.glanceDisplay : null,
    getProvider: () => ALL_APPS.find(app => app.glanceboard)?.glanceboard ?? null,
    canShow: () => this.runtimeNeeded && !this.glassesLocked,
    // iOS retains the EvenHub session while the shell sleeps. The board's
    // opaque first frame is ready before we unblank the compositor.
    ensureSessionActive: async () => {
      await this.display?.setScreenBlanked(false); this.schedulePreviewUpdate(); return true
    },
    onHiddenWhileAsleep: () => {
      if (!shell.isScreenOn()) void this.display?.setScreenBlanked(true).then(() => this.schedulePreviewUpdate())
      else this.schedulePreviewUpdate()
    },
    onVisibilityChanged: () => this.schedulePreviewUpdate(),
    appendLog: message => this.logBluetooth(message),
  })
  private previewTimer: ReturnType<typeof setTimeout> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private offSettings: (() => void) | null = null
  private lastBrightness: string | null = null
  private active = false
  private runtimeRunning = false
  private clockMinute = -1
  private shellRenderInProgress = false
  private shellRenderQueued = false
  private nextFrameId = 1
  private nextWorkerFrame = 0
  private inputQueue: Promise<void> = Promise.resolve()
  private lastLayout = ''
  private readonly appHosts = new Map<string, WorkerAppHost>()
  private readonly inProcessApps = new Map<string, InProcessWindow>()
  private readonly batteryObservers: any[] = []
  private readonly lockObservers: any[] = []
  private phoneLocked = false
  private glassesWorn: boolean | null = null
  private glassesLocked = false
  private lockEnabled = lockScreenEnabledSetting.get()
  private acknowledgedFrames = 0
  private logLines: string[] = []
  private logTimer: ReturnType<typeof setTimeout> | null = null
  private readonly actions: LayerActions = {
    ...noopLayerActions,
    playBuzzerSequence: payload => this.communicator?.playBuzzerSequence(payload),
    requestRender: () => this.requestShellRender(),
    disconnect: () => this.disconnect(),
    startVoiceCapture: endpointing => this.startVoiceCapture(endpointing),
    stopVoiceCapture: () => iosVoiceInput.stopPushToTalk(),
    startContinuousVoiceCapture: () => this.onError("Voice capture is not available on iOS yet."),
    startTextSettingEdit: async setting => { await this.editSetting(setting) },
    startTextSettingsEdit: async (settings, title, finished, toggle, cancelled) => {
      for (const setting of settings) if (!await this.editSetting(setting)) { cancelled?.(); return }
      if (toggle) {
        const choice = await Dialogs.action({ title, cancelButtonText: 'Cancel', actions: [toggle.label, 'This session only'] })
        if (choice === 'Cancel') { cancelled?.(); return }
        toggle.setting.set(choice === toggle.label)
      }
      finished?.()
    },
  }

  constructor(private readonly onFrame: (image: ImageSource, focus: string) => void,
    private readonly onError: (message: string) => void,
    private readonly onConnectionState: (state: SessionState) => void = () => {},
    private readonly onKeyboardInputChanged: (session: KeyboardInputSession | null) => void = () => {}) {
    this.ensurePreviewDisplay()
    shell.configure({
      actions: this.actions,
      voiceInputEnabled: true,
      onKeyboardInputChanged: session => this.onKeyboardInputChanged(session ? {
        targets: session.targets,
        setText: text => { if (this.active && !this.glassesLocked) session.setText(text) },
        send: () => { if (this.active && !this.glassesLocked) session.send() },
        sendTo: id => { if (this.active && !this.glassesLocked) session.sendTo(id) },
        discard: () => session.discard(),
      } : null),
      prepareVoiceCapture: () => this.prepareVoiceCapture(),
      getScreenTimeoutMs: () => null,
      requestShellRender: () => this.requestShellRender(),
      onWindowsChanged: () => this.requestShellRender(),
      onScreenStateChanged: on => {
        if (on) this.glance.dismiss()
        void this.display?.setScreenBlanked(!on).catch(error => this.fail(error))
        this.requestShellRender()
      },
    })
    const launcher = createLauncherWindow({
      actions: this.actions,
      apps: () => launcherEntries(ALL_APPS),
      launchApp: id => this.launchApp(id),
      uninstallApp: id => this.uninstallApp(id),
      submitFrame: planes => this.submit(LAUNCHER_SURFACE_ID, planes),
      setSurfaceVisible: visible => this.setWindowSurfaceVisible(LAUNCHER_SURFACE_ID, visible),
    })
    void this.configureWindow(launcher)
    shell.registerWindow(launcher)
    shell.wake('window')
    shell.focusWindow(launcher.windowId)
    onIosNotificationPopup(key => {
      const notification = readActiveNotifications(128).find(n => n.key === key)
      if (this.glassesLocked || !notification || !shouldShowNotificationOnGlasses(notification.packageName)) return
      const woke = !shell.isScreenOn() && shell.wake('sidebar')
      shell.openNotificationModal(key, woke)
      this.requestShellRender()
    })
    startRemoteInput({
      ready: () => this.runtimeRunning,
      locked: () => this.glassesLocked,
      input: (gesture, source) => {
        // Share the controller queue with physical input. A discrete hold includes its release.
        const task = this.inputQueue.then(async () => {
          await this.receiveInput(makeInputEvent({ type: gesture, source } as InputEventPayload))
          if (gesture === 'long-press') await this.receiveInput(makeInputEvent({ type: 'long-press-release', source }))
        })
        this.inputQueue = task.catch(error => this.fail(error))
        return task
      },
      acceptsText: () => !!shell.foregroundWindow()?.receiveTextInput,
      text: (text, submit) => { if (!shell.isScreenOn()) shell.wake('window'); shell.sendTextToForegroundWindow(text, { submit }); this.requestShellRender() },
      assistantAvailable: () => shell.isAssistantAvailable(),
      assistant: text => shell.sendToAssistant(text),
    })
    registerSystemTools()
    registerWindowTools({ apps: ALL_APPS.filter(app => !iosAppUnavailableReason(app.appId)),
      launchApp: id => this.launchApp(id), requestShellRender: () => this.requestShellRender() })
    registerNavigateTools(id => this.launchApp(id))
    registerRoamTools(id => this.launchApp(id))
    for (const app of ALL_APPS) if (app.appId !== 'launcher' && !iosAppUnavailableReason(app.appId)) app.boot?.(this.buildAppContext(app))
  }

  /** The compositor frames go to: the live session, else the headless preview. */
  private get display(): DisplayTarget | null { return this.communicator ?? this.previewTarget }

  private ensurePreviewDisplay(): void {
    if (this.communicator || this.previewTarget) return
    const target = new PreviewDisplayTarget()
    this.previewTarget = target
    target.activate(() => this.schedulePreviewUpdate())
    this.displayReady = this.registerSurfaces(target).catch(error => this.fail(error))
  }

  private teardownPreviewDisplay(): void {
    const target = this.previewTarget
    if (!target) return
    this.previewTarget = null
    this.glance.reset()
    target.release()
  }

  /** (Re)create every compositor surface on a fresh display target. */
  private async registerSurfaces(target: DisplayTarget): Promise<void> {
    await target.configureCompositorScreen(G2_LENS_WIDTH, G2_LENS_HEIGHT)
    await target.configureSurface(SHELL_SURFACE_ID, { x: 0, y: 0, width: G2_LENS_WIDTH, height: G2_LENS_HEIGHT,
      zOrder: SHELL_SURFACE_Z_ORDER, transparency: 'color-key' })
    await target.setUnderlayDim(SHELL_SURFACE_Z_ORDER, 1)
    await target.configureSurface(LOCK_SCREEN_SURFACE_ID, {
      x: 0, y: 0, width: G2_LENS_WIDTH, height: G2_LENS_HEIGHT, zOrder: LOCK_SURFACE_Z_ORDER, transparency: 'opaque',
    })
    if (this.glassesLocked) await this.submitLockImage(target)
    await target.setSurfaceVisible(LOCK_SCREEN_SURFACE_ID, this.glassesLocked)
    await target.setScreenBlanked(!shell.isScreenOn())
    this.lastLayout = ''
    for (const window of shell.getWindows()) await this.configureWindow(window, target)
  }

  private async submitLockImage(target: DisplayTarget): Promise<void> {
    const image = createLockScreenImage()
    await target.submitSurfaceFrame(LOCK_SCREEN_SURFACE_ID, image.to8bppBuffer(),
      { x: 0, y: 0, width: image.width, height: image.height }, 'lock-screen', 0, 0)
  }

  resume(): void {
    if (this.active) return
    this.active = true
    this.syncRuntime()
    this.handlePhoneLockState(!UIApplication.sharedApplication.protectedDataAvailable)
    this.logBluetooth('Phone foreground')
    if (this.communicator) this.onConnectionState({ ...this.state })
    this.relayout()
    shell.foregroundWindow()?.requestRender()
    this.requestShellRender()
  }
  pause(): void {
    if (!this.active) return
    this.active = false
    iosVoiceInput.stopPhoneCapture()
    // The phone preview is hidden; the glasses still own their screen and input.
    this.syncRuntime()
    this.logBluetooth(`Phone background; glasses ${this.state.phase}`)
    this.flushBluetoothLog()
  }
  private get runtimeNeeded(): boolean {
    return this.active || ['connected', 'connecting', 'retrying', 'disconnecting'].includes(this.state.phase)
  }
  private syncRuntime(): void {
    const running = this.runtimeNeeded
    if (running === this.runtimeRunning) return
    this.runtimeRunning = running
    for (const window of shell.getWindows()) window.setScreenOn?.(running && shell.isScreenOn())
    if (!running) {
      void nightscoutBridge.stop().catch(error => this.fail(error))
      this.glance.dismiss()
      void this.display?.setScreenBlanked(!shell.isScreenOn()).catch(error => this.fail(error))
      this.offSettings?.(); this.offSettings = null
      for (const observer of this.batteryObservers.splice(0)) NSNotificationCenter.defaultCenter.removeObserver(observer)
      for (const observer of this.lockObservers.splice(0)) NSNotificationCenter.defaultCenter.removeObserver(observer)
      UIDevice.currentDevice.batteryMonitoringEnabled = false
      if (this.clockTimer !== null) clearInterval(this.clockTimer)
      if (this.previewTimer !== null) clearTimeout(this.previewTimer)
      this.clockTimer = this.previewTimer = null
      return
    }
    UIDevice.currentDevice.batteryMonitoringEnabled = true
    // Keep these observers alive while BLE owns the runtime, including background.
    for (const [name, locked] of [
      [UIApplicationProtectedDataWillBecomeUnavailable, true],
      [UIApplicationProtectedDataDidBecomeAvailable, false],
    ] as const) {
      this.lockObservers.push(NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
        name, null, NSOperationQueue.mainQueue, () => this.handlePhoneLockState(locked)))
    }
    this.handlePhoneLockState(!UIApplication.sharedApplication.protectedDataAvailable)
    this.syncLockSetting()
    void nightscoutBridge.start().catch(error => this.fail(error))
    for (const name of [UIDeviceBatteryLevelDidChangeNotification, UIDeviceBatteryStateDidChangeNotification]) {
      this.batteryObservers.push(NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(name, null, NSOperationQueue.mainQueue, () => this.requestShellRender()))
    }
    const phone = readPhoneBatteryState()
    this.logBluetooth(`Phone battery ${phone.battery ?? "unknown"}% charging=${phone.charging}`)
    this.offSettings = onAnySettingChanged(() => {
      this.syncLockSetting()
      this.pushBrightness()
      this.relayout()
      shell.foregroundWindow()?.requestRender()
      this.requestShellRender()
    })
    this.clockTimer = setInterval(() => this.refreshClock(), 60_000)
  }
  private pushBrightness(): void {
    const communicator = this.communicator
    if (!communicator || this.state.phase !== 'connected') { this.lastBrightness = null; return }
    const value = brightnessSetting.get()
    if (value === this.lastBrightness) return
    this.lastBrightness = value
    const level = brightnessSettingToLevel(value)
    void communicator.setBrightness(level === null, level ?? 0).catch(error => {
      this.lastBrightness = null
      this.logBluetooth(`Brightness: ${String(error)}`)
    })
  }
  private syncLockSetting(): void {
    const enabled = lockScreenEnabledSetting.get()
    if (enabled === this.lockEnabled) return
    this.lockEnabled = enabled
    if (!enabled) this.setGlassesLocked(false)
    else {
      if (this.phoneLocked && this.glassesWorn === false) this.setGlassesLocked(true)
      if (this.communicator && this.state.phase === 'connected')
        void this.communicator.enableWearDetectionAndRequestState().catch(error => this.fail(error))
    }
  }
  private handlePhoneLockState(locked: boolean): void {
    this.phoneLocked = locked
    this.communicator?.onPhoneLockSignal()
    if (!locked) this.setGlassesLocked(false)
    else if (this.lockEnabled && this.glassesWorn === false) this.setGlassesLocked(true)
  }
  private handleWearState(wearing: boolean): void {
    // Sample false to catch a notification missed during suspension. Do not
    // sample true here: WillBecomeUnavailable precedes the property transition.
    if (!UIApplication.sharedApplication.protectedDataAvailable) this.handlePhoneLockState(true)
    this.glassesWorn = wearing
    this.logBluetooth(`Glasses wear state: ${wearing ? 'ON_HEAD' : 'OFF_HEAD'}`)
    if (!wearing && this.phoneLocked && this.lockEnabled) this.setGlassesLocked(true)
  }
  private setGlassesLocked(locked: boolean): void {
    if (locked === this.glassesLocked) return
    this.glassesLocked = locked
    if (locked) {
      this.glance.dismiss()
      iosVoiceInput.handleSessionEnded('Glasses locked. Unlock your phone to start voice input again.')
    }
    void (async () => {
      await this.displayReady
      const display = this.display
      if (!display) return
      {
        if (locked) await this.submitLockImage(display)
        await display.setSurfaceVisible(LOCK_SCREEN_SURFACE_ID, locked)
        this.schedulePreviewUpdate()
      }
    })().catch(error => this.fail(error))
    this.logBluetooth(`Glasses ${locked ? 'locked' : 'unlocked'}`)
    this.requestShellRender()
  }
  private refreshClock(): void {
    const minute = Math.floor(Date.now() / 60_000)
    if (minute !== this.clockMinute) { this.clockMinute = minute; this.requestShellRender() }
  }
  private async configureWindow(window: ShellWindow, target: DisplayTarget | null = this.display): Promise<void> {
    if (!target) return
    await target.configureSurface(window.surfaceId, {
      ...appViewportRect(window.heightMode, window.appId), zOrder: 0, transparency: 'opaque',
    })
    await target.setSurfaceVisible(window.surfaceId, shell.foregroundWindow()?.windowId === window.windowId)
  }
  private relayout(): void {
    const layout = shell.getWindows().map(window => JSON.stringify(appViewportRect(window.heightMode, window.appId))).join(";")
    if (layout === this.lastLayout) return
    this.lastLayout = layout
    for (const window of shell.getWindows()) {
      void this.configureWindow(window).catch(error => this.fail(error))
      window.relayout?.()
    }
  }
  /** Submit a painted frame for an in-process window (e.g. the launcher). */
  private async submit(id: string, planes: Plane[]): Promise<void> {
    await this.displayReady
    const display = this.display
    if (!display) return
    const fingerprint = planesFingerprint(planes)
    const { image, draws } = flattenPlanesWithDraws(planes)
    await display.submitSurfaceFrame(id, image.pixels, { x: 0, y: 0, width: image.width, height: image.height },
      fingerprint, -1, 0, prepareFrameDraws(draws))
    this.schedulePreviewUpdate()
  }
  /** Worker windows ship baked pixels; every submit is new content to the compositor. */
  private async submitWorkerPixels(id: string, pixels: Uint8Array, width: number, height: number, draws: ArrayBuffer | null): Promise<void> {
    await this.displayReady
    const display = this.display
    if (!display) return
    await display.submitSurfaceFrame(id, pixels, { x: 0, y: 0, width, height }, `${id}#${++this.nextWorkerFrame}`, -1, 0, draws)
    this.schedulePreviewUpdate()
  }
  private setWindowSurfaceVisible(id: string, visible: boolean): void {
    void this.display?.setSurfaceVisible(id, visible).then(() => this.schedulePreviewUpdate()).catch(error => this.fail(error))
  }
  private removeWindowSurface(id: string): void {
    void this.display?.removeSurface(id).then(() => this.schedulePreviewUpdate()).catch(error => this.fail(error))
  }
  /** Re-render and resubmit the shell surface; one render in flight, at most one queued. */
  private requestShellRender(): void {
    if (this.shellRenderInProgress) { this.shellRenderQueued = true; return }
    this.shellRenderInProgress = true
    void (async () => {
      try {
        do {
          this.shellRenderQueued = false
          await this.renderShell()
        } while (this.shellRenderQueued)
      } catch (error) { this.fail(error) }
      finally { this.shellRenderInProgress = false }
    })()
  }
  private async renderShell(): Promise<void> {
    await this.displayReady
    const display = this.display
    if (!display) return
    const startedAt = Date.now()
    const bytes = shell.paintScene()
    const frameId = this.allocateFrameId()
    await display.submitShellScene(bytes, Date.now() - startedAt, frameId)
    // Backpressure: the next shell render waits for this one to reach the
    // glasses (the preview target resolves immediately; nothing transmits).
    await display.waitForFrameFinished(frameId, FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS)
    this.schedulePreviewUpdate()
  }
  private allocateFrameId(): number {
    const id = this.nextFrameId
    this.nextFrameId = this.nextFrameId >= 0x7fffffff ? 1 : this.nextFrameId + 1
    return id
  }
  /** Refresh the phone mirror from the composited screen, coalesced at 30 fps. */
  private schedulePreviewUpdate(): void {
    if (!this.active || this.previewTimer !== null) return
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      if (!this.active) return
      try {
        const image = this.display?.getCompositePreview(previewColorSetting.get() === 'green')
        if (!image) return
        this.onFrame(image, this.glassesLocked ? 'Glasses locked' : this.glance.isVisible() ? 'Glanceboard'
          : `${shell.foregroundWindow()?.title ?? 'Apps'} · ${shell.getFocus() === 'sidebar' ? 'App switcher' : 'App'}`)
      } catch (error) { this.fail(error) }
    }, 33)
  }
  private fail(error: unknown): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(`[ios-preview] ${message}`)
    this.logBluetooth(`App error: ${message}`)
    if (this.active) this.onError(error instanceof Error ? error.message : String(error))
  }
  gesture(gesture: PhoneGesture, origin: 'watch' | 'ring' | 'mirror', nx = 0, ny = 0): void {
    this.inputQueue = this.inputQueue.then(async () => {
      if (!this.active) return
      if (gesture === 'tap' && origin === 'mirror' && shell.isScreenOn() && !this.glassesLocked) {
        await this.mirrorTap(nx, ny)
      } else {
        let type: string = ({ tap: 'click', 'double-tap': 'double-click' } as Record<string, string>)[gesture] ?? gesture
        if (origin === 'ring' && type.startsWith('swipe-')) {
          if (type === 'swipe-left' || type === 'swipe-right') return
          type = type === 'swipe-up' ? 'scroll-up' : 'scroll-down'
        }
        const event = makeInputEvent({ type, source: origin === 'ring' ? 'ring' : 'watch' } as InputEventPayload)
        await this.receiveInput(event)
      }
      console.log(`[ios-preview] ${origin} ${gesture}: ${shell.describeInputTarget()}`)
    }).catch(error => this.fail(error))
  }
  private async receiveInput(event: InputEvent, headTilt = false): Promise<void> {
    if (!acceptInput(event)) return
    if (this.glassesLocked) {
      // Preserve the locked display's sleep/wake controls without dispatching
      // gestures to apps, shell menus, voice input or the Glanceboard.
      if (event.type === 'double-click' && (event.source === 'ring' || event.source === 'watch')) {
        if (shell.isScreenOn()) shell.sleep()
        else shell.wake('sidebar')
      } else if (event.type === 'display-wake' && !shell.isScreenOn()) shell.wake('sidebar')
      this.requestShellRender()
      return
    }
    if (!shell.isScreenOn()) {
      const glanceEvent = this.glance.eventForGesture(headTilt ? 'head-tilt' : event.type)
      if (glanceEvent?.type === 'dismiss') this.glance.dismiss()
      else if (glanceEvent) {
        await this.glance.handleEvent(glanceEvent, 0)
        return
      }
    }
    await shell.receiveInput(event)
    this.requestShellRender()
  }
  private async mirrorTap(nx: number, ny: number): Promise<void> {
    const x = Math.max(0, Math.min(639, Math.floor(nx * 640)))
    const y = Math.max(0, Math.min(479, Math.floor(ny * 480)))
    const window = shell.foregroundWindow()
    if (!shell.hasOverlay() && sidebarStripVisible(shell.getFocus(), window?.appId) && x < SIDEBAR_WIDTH) {
      const target = shell.windowAtSidebarPoint(x, y)
      if (target) { shell.focusWindow(target.windowId); target.requestRender(); this.requestShellRender() }
      return
    }
    if (window && !shell.hasOverlay()) {
      const rect = appViewportRect(window.heightMode, window.appId)
      if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) return
      shell.focusWindow(window.windowId)
      if (await window.hitTest?.(x - rect.x, y - rect.y)) { this.requestShellRender(); return }
    }
    await shell.receiveInput(makeInputEvent({ type: 'click', source: 'watch' }))
    this.requestShellRender()
  }
  async launchApp(id: string, params?: AppLaunchParams): Promise<void> {
    const app = ALL_APPS.find(app => app.appId === id)
    if (!app) {
      const installed = getInstalledEvenHubAppById(id)
      const host = ALL_APPS.find(app => app.appId === 'evenhub')
      if (installed && host) {
        try {
          if (isInstalledPackagePresent(installed.packageId))
            await launchInstalledPackage(this.buildAppContext({ ...host, appId: id }), installed)
          else await openEvenHubStoreForPackage(this.buildAppContext(host), installed)
        }
        catch (error) { this.fail(error) }
      }
      return
    }
    try {
      const reason = iosAppUnavailableReason(id)
      if (reason) {
        await this.launchInProcessApp(id, `window:${id}`, options => createInProcessWindow({
          ...options, appId: id, windowId: id, title: app.title, icon: app.icon,
          iconLetter: app.title[0], closeable: true,
          baseLayer: new YieldAtRootLayer(new TextViewerLayer(reason, app.title)),
        }))
      } else await app.launch(this.buildAppContext(app), params)
      console.log(`[ios-preview] Launched ${id}`)
    } catch (error) { this.fail(error) }
  }
  private async uninstallApp(id: string): Promise<void> {
    const packageId = installedEvenHubPackageId(id)
    if (!packageId) return
    closeRunningPackage(packageId)
    uninstallEvenHubPackage(packageId)
    this.requestShellRender()
  }
  private buildAppContext(app: AppDefinition): AppContext {
    return {
      appId: app.appId, apps: ALL_APPS, actions: this.actions,
      launchApp: (id, params) => this.launchApp(id, params), uninstallApp: id => this.uninstallApp(id),
      launchInProcessApp: (id, surface, create) => this.launchInProcessApp(id, surface, create),
      ensureWorkerHost: create => this.ensureWorkerHost(app.appId, create),
      submitWindowFrame: (id, planes) => this.submit(id, planes),
      setWindowSurfaceVisible: (id, visible) => this.setWindowSurfaceVisible(id, visible),
      requestShellRender: () => this.requestShellRender(), appendLog: message => console.log(`[ios-app] ${message}`),
      setTextEditorHost: () => {},
    }
  }
  private async launchInProcessApp(windowId: string, surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow): Promise<void> {
    const existing = this.inProcessApps.get(windowId)
    if (existing) { shell.focusWindow(windowId); existing.requestRender(); this.requestShellRender(); return }
    // Apps can request a render while their factory runs (Nightscout's tray
    // subscription does). The surface only exists once the factory returns.
    // The explicit render below supplies a fresh frame after configuration.
    let surfaceReady = false
    const app = create({
      actions: this.actions, submitFrame: planes => surfaceReady ? this.submit(surfaceId, planes) : Promise.resolve(),
      setSurfaceVisible: visible => this.setWindowSurfaceVisible(surfaceId, visible),
      removeSurface: () => { surfaceReady = false; this.removeWindowSurface(surfaceId) },
      reconfigureSurface: () => {
        const window = shell.getWindows().find(w => w.windowId === windowId)
        if (window) void this.configureWindow(window).catch(error => this.fail(error))
        this.requestShellRender()
      },
      onClosed: () => { this.inProcessApps.delete(windowId) },
    })
    this.inProcessApps.set(windowId, app)
    await this.configureWindow(app.window)
    surfaceReady = true
    shell.registerWindow(app.window); shell.focusWindow(windowId)
    app.requestRender(); this.requestShellRender()
  }
  private ensureWorkerHost(appId: string, create: () => Worker): WorkerAppHost {
    const existing = this.appHosts.get(appId)
    if (existing) return existing
    const worker = create()
    const navigationSensors = appId === 'navigate'
      ? new IosNavigationSensors(event => worker.postMessage({ type: 'navigation-sensors', event })) : undefined
    const host = new WorkerAppHost({
      appId, worker, navigationSensors,
      onStopping: () => { if (this.appHosts.get(appId) === host) this.appHosts.delete(appId) },
      playBuzzerSequence: payload => this.actions.playBuzzerSequence(payload),
      openUrl: url => { void Utils.openUrl(url) },
      configureSurface: async (id, visible, heightMode) => {
        const display = this.display
        if (!display) return
        await display.configureSurface(id, { ...appViewportRect(heightMode, appId), zOrder: 0, transparency: 'opaque' })
        await display.setSurfaceVisible(id, visible)
      },
      setSurfaceVisible: (id, visible) => this.setWindowSurfaceVisible(id, visible),
      removeSurface: id => this.removeWindowSurface(id),
      submitPixels: (id, pixels, width, height, draws) => {
        void this.submitWorkerPixels(id, pixels, width, height, draws).catch(error => this.fail(error))
      },
      requestShellRender: () => this.requestShellRender(),
      openSettings: section => { void this.launchApp('settings', { section }) },
      startTextSettingEdit: id => { const setting = getStringSettingById(id); if (setting) void this.editSetting(setting) },
      endTextSettingEdit: () => {},
      startTextInput: () => shell.startVoiceInput(),
    })
    this.appHosts.set(appId, host)
    return host
  }
  cycleDisplayMode(): void {
    const values = DISPLAY_MODE_VALUES
    displayModeSetting.set(values[(values.indexOf(displayModeSetting.get()) + 1) % values.length])
  }
  get displayModeLabel(): string { return displayModeLabel(displayModeSetting.get()) }
  get connectionState(): SessionState | null { return this.sessionCreated ? this.state : null }
  get connectionDetails(): string {
    const state = this.connectionState
    return state ? `${state.status}\nL: ${state.leftVersion || 'unknown'}\nR: ${state.rightVersion || 'unknown'}\nBattery: ${state.battery ?? '?'}%\nRing: ${state.ring ? 'connected' : 'disconnected'}\nFrames acknowledged: ${state.frames}\n${state.capabilities}\n\n${this.logLines.slice(-12).join('\n')}` : 'Preview only. Configure devices, then connect.'
  }
  private update(phase: SessionPhase, status: string): void {
    this.state = { ...this.state, phase, status }
    this.logBluetooth(status)
    this.emitState()
  }
  private emitState(): void {
    if (this.state.phase !== 'connected') resetRingInputFilter()
    this.pushBrightness()
    this.maybePlayWelcomeSound(this.state)
    if (this.state.phase !== 'connected' && this.state.phase !== 'connecting') this.glassesWorn = null
    if (this.state.phase !== 'connected') iosVoiceInput.handleSessionEnded()
    shell.setBatteryLevels({ headset: this.state.battery, headsetCharging: this.state.charging })
    this.syncRuntime()
    if (this.active) this.onConnectionState({ ...this.state })
    this.requestShellRender()
  }
  async connect(): Promise<void> {
    if (!this.active || this.connecting || this.stopping) return
    if (this.communicator && ['connecting', 'connected', 'retrying', 'disconnecting'].includes(this.state.phase)) return
    const addresses = loadDeviceAddresses(), error = deviceAddressError(addresses)
    if (error) { this.onError(error); return }
    this.connecting = true
    this.sessionCreated = true
    try {
      this.state = { ...this.state, capabilities: '', leftVersion: '', rightVersion: '', battery: null, charging: null, ring: false }
      this.update('connecting', 'Finding configured devices…')
      let identifiers
      try { identifiers = await resolveIosPeripherals(addresses) }
      catch (failure) {
        this.update('error', failure instanceof Error ? failure.message : String(failure))
        return
      }
      if (this.communicator) await this.closeCommunicator()
      const communicator = new FaceclawCommunicatorBridge(identifiers)
      this.teardownPreviewDisplay()
      this.communicator = communicator
      this.wearDetectionRequested = false
      this.bindCommunicator(communicator)
      this.displayReady = this.registerSurfaces(communicator)
      await this.displayReady
      this.update('connecting', 'Connecting to the glasses…')
      this.startedCommunicators.add(communicator)
      await communicator.start()
      for (const window of shell.getWindows()) window.requestRender()
      this.requestShellRender()
    } catch (failure) {
      this.fail(failure)
      await this.closeCommunicator().catch(() => {})
      this.ensurePreviewDisplay()
      this.update('error', failure instanceof Error ? failure.message : String(failure))
    } finally {
      this.connecting = false
    }
  }
  private bindCommunicator(communicator: FaceclawCommunicatorBridge): void {
    const notifications = new AncsClient(packet => communicator.writeRawToRight(packet), (key, popup) => {
      iosNotificationsChanged(key, popup); this.requestShellRender()
    }, message => this.logBluetooth('ANCS: ' + message))
    this.notifications = notifications
    bindIosNotifications(notifications)
    bindCompassSession(communicator)
    communicator.setRequiresAncs(true)
    this.sessionOffs.push(
      communicator.onStateChange(state => this.handleSessionState(communicator, state)),
      communicator.onRingEvent(input => this.handleRingEvent(input)),
      communicator.onBatteryState(state => {
        if (this.communicator !== communicator) return
        this.state = { ...this.state, battery: state.battery >= 0 && state.battery <= 100 ? state.battery : this.state.battery,
          charging: state.chargingStatus >= 0 ? state.chargingStatus > 0 : this.state.charging,
          ring: (state.ringBattery ?? -1) >= 0 || this.state.ring }
        shell.setBatteryLevels({ headset: this.state.battery, headsetCharging: this.state.charging })
        if (this.active) this.onConnectionState({ ...this.state })
        this.requestShellRender()
      }),
      communicator.onFirmwareInfo(info => {
        if (this.communicator !== communicator) return
        this.state = { ...this.state, leftVersion: info.leftVersion || this.state.leftVersion,
          rightVersion: info.rightVersion || this.state.rightVersion, capabilities: info.extension || this.state.capabilities }
        if (this.active) this.onConnectionState({ ...this.state })
        this.syncNotifications(communicator)
      }),
      communicator.onFrameMetrics(() => {
        if (this.communicator !== communicator) return
        this.state = { ...this.state, frames: this.state.frames + 1 }
        this.onActivity()
        this.maybePlayWelcomeSound(this.state)
        if (this.active) this.onConnectionState({ ...this.state })
        this.schedulePreviewUpdate()
      }),
      communicator.onWearState(wearing => { if (this.communicator === communicator) this.handleWearState(wearing) }),
      communicator.addCompassListener(receiveCompassEvent),
      communicator.onAncsRelayFrame(frame => { if (this.communicator === communicator) notifications.receive(frame) }),
      communicator.onAncsAuthorization(authorized => {
        if (this.communicator !== communicator) return
        if (authorized) { this.syncNotifications(communicator); return }
        const active = notifications.state !== 'disconnected'
        const command = notifications.stopCommand()
        notifications.stop('Enable Share System Notifications in iPhone Settings → Bluetooth → right lens.')
        if (active && this.state.phase === 'connected') void communicator.writeRawToRight(command).catch(() => {})
      }),
    )
  }
  private handleSessionState(communicator: FaceclawCommunicatorBridge, state: CommunicatorState): void {
    if (this.communicator !== communicator) return
    // Registering the listener makes the Kotlin session report its current state, which is
    // "disconnected" before start(); that must not be mistaken for the session ending.
    if (!this.startedCommunicators.has(communicator)) return
    const phase: SessionPhase = state.phase === 'charging' ? 'connected' : state.phase === 'unpaired' ? 'error' : state.phase
    if (phase === 'connected' && this.state.phase !== 'connected') {
      this.state = { ...this.state, frames: this.state.frames }
      if (!this.wearDetectionRequested) {
        this.wearDetectionRequested = true
        void communicator.enableWearDetectionAndRequestState().catch(error => this.logBluetooth(`Wear detection: ${String(error)}`))
      }
    }
    this.update(phase, state.status)
    if (phase === 'connected') this.syncNotifications(communicator)
    else if ((phase === 'disconnected' || phase === 'error') && !this.stopping) {
      // The session ended on its own (retries exhausted, an arm unpaired): release it and go headless.
      void this.disconnect(state.status)
    }
  }
  private handleRingEvent(input: RawInputEvent): void {
    this.inputQueue = this.inputQueue.then(async () => {
      if (this.state.phase !== 'connected') return
      this.onActivity()
      if (input.ringInput) this.state = { ...this.state, ring: true }
      await this.receiveInput(rawInputEventToInputEvent(input),
        input.kind === 'display-wake' && input.eventType === OsEventTypeList.HEAD_UP_EVENT)
      this.logBluetooth(`Input ${input.eventType} source ${input.eventSource}`)
    }).catch(error => this.fail(error))
  }
  /** Any glasses traffic: CoreBluetooth can wake a suspended process, so refresh what timers would have. */
  private onActivity(): void {
    if (!UIApplication.sharedApplication.protectedDataAvailable) this.handlePhoneLockState(true)
    this.refreshClock()
  }
  /** Start iPhone notification relay once the firmware is known to support it and ANCS is authorized. */
  private syncNotifications(communicator: FaceclawCommunicatorBridge): void {
    const notifications = this.notifications
    if (!notifications || this.state.phase !== 'connected') return
    if (!ancsCapable(this.state.capabilities)) {
      if (this.state.capabilities) notifications.stop(`Update glasses to Faceclaw firmware ${ANCS_FIRMWARE_VERSION} or newer for iPhone notifications.`)
      return
    }
    if (notifications.state !== 'disconnected') return
    notifications.start((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0, communicator.rightWriteLimit())
  }
  async disconnect(reason?: string): Promise<void> {
    if (this.stopping) return this.stopping
    const communicator = this.communicator
    if (!communicator) return
    // Marked before any bridge call: the session may report "disconnected" from inside disconnect().
    let finished!: () => void
    this.stopping = new Promise<void>(resolve => { finished = resolve })
    try {
      const notifications = this.notifications
      if (notifications && notifications.state !== 'disconnected') {
        const command = notifications.stopCommand()
        notifications.stop()
        if (this.state.phase === 'connected') { try { await communicator.writeRawToRight(command) } catch {} }
      }
      if (this.state.phase === 'connected' || this.state.phase === 'connecting' || this.state.phase === 'retrying')
        this.update('disconnecting', 'Disconnecting…')
      await communicator.disconnect().catch(error => this.logBluetooth(`Disconnect: ${String(error)}`))
    } finally {
      await this.closeCommunicator()
      this.ensurePreviewDisplay()
      this.update(reason ? 'error' : 'disconnected', reason ?? 'Preview only')
      this.stopping = null
      finished()
    }
  }
  private async closeCommunicator(): Promise<void> {
    const communicator = this.communicator
    if (!communicator) return
    for (const off of this.sessionOffs.splice(0)) off()
    this.notifications = null
    this.communicator = null
    this.glance.reset()
    await communicator.close().catch(error => this.logBluetooth(`Close: ${String(error)}`))
  }
  private maybePlayWelcomeSound(state: SessionState): void {
    const firstNewFrame = state.frames > this.acknowledgedFrames
    this.acknowledgedFrames = state.frames
    // Match Android: wait for an acknowledged frame before consuming the jingle.
    if (!firstNewFrame || state.phase !== 'connected' || !isWelcomeSoundPending()) return
    setWelcomeSoundPending(false)
    const effect = findSoundEffect('questcomplete')
    if (effect) void playSoundEffect(effect, payload => this.actions.playBuzzerSequence(payload),
      ms => new Promise(resolve => setTimeout(resolve, ms)))
      .catch(error => this.logBluetooth(`Welcome sound failed: ${error}`))
  }
  startVoiceInput(): void { if (!this.glassesLocked) shell.startVoiceInput() }
  private async prepareVoiceCapture(): Promise<boolean> {
    if (this.glassesLocked) return false
    const usePhoneMic = this.state.phase !== 'connected'
    if (usePhoneMic && !this.active) return false
    const ready = await iosVoiceInput.prepare(this.active, usePhoneMic)
    if (!ready && this.active) this.onError(iosVoiceInput.statusText)
    return ready && !this.glassesLocked && (this.state.phase === 'connected' || this.active)
  }
  private async startVoiceCapture(endpointing = false): Promise<void> {
    if (this.glassesLocked) return
    const log = (message: string) => this.logBluetooth(message)
    const communicator = this.communicator
    if (communicator && this.state.phase === 'connected') {
      await iosVoiceInput.startGlassesCapture(communicator, log, endpointing)
    } else if (this.active) {
      // Recheck microphone permission if the glasses disconnected after prepare.
      if (!await iosVoiceInput.prepare(this.active, true) || !this.active || this.glassesLocked) return
      await iosVoiceInput.startPhoneCapture(log, endpointing)
    }
  }
  private logBluetooth(message: string): void {
    const line = `${new Date().toISOString()} [${this.active ? 'foreground' : 'background'}${UIApplication.sharedApplication.protectedDataAvailable ? '' : ',protected-data-unavailable'}] ${message}`
    console.log(`[ios-ble] ${line}`); this.logLines.push(line)
    if (this.logLines.length > 1000) this.logLines.shift()
    if (this.logTimer !== null) return
    this.logTimer = setTimeout(() => {
      this.logTimer = null
      this.flushBluetoothLog()
    }, 500)
  }
  private flushBluetoothLog(): void {
    if (this.logTimer !== null) clearTimeout(this.logTimer)
    this.logTimer = null
    try { File.fromPath(path.join(knownFolders.documents().path, 'bluetooth.log')).writeTextSync(this.logLines.join('\n')) }
    catch (error) { console.warn(`Bluetooth log: ${error}`) }
  }
  typeIntoApp(): void {
    if (this.glassesLocked || !this.active) return
    shell.startKeyboardInput()
  }
  private async editSetting(setting: { editorTitle: string; inputKind?: string; get(): string; set(value: string): void }): Promise<boolean> {
    if (!this.active) { this.logBluetooth('Editing text settings requires opening Faceclaw on the phone'); return false }
    const result = await Dialogs.prompt({ title: setting.editorTitle, defaultText: setting.get(), inputType: setting.inputKind, okButtonText: 'Save', cancelButtonText: 'Cancel' })
    if (result.result) {
      setting.set(result.text)
      if (setting === nightscoutSiteUrlSetting || setting === nightscoutApiTokenSetting) await nightscoutBridge.refreshNow()
    }
    return result.result
  }
}
