import { Dialogs, File, knownFolders, path, type ImageSource } from '@nativescript/core'
import { iosBluetooth } from '../native/ios-bluetooth'
import { GlassesSession, type SessionState } from './glasses-session'
import { loadDeviceAddresses } from './device-addresses'
import { deviceAddressError } from './ios-peripheral-identity'
import { createLauncherWindow, LAUNCHER_SURFACE_ID } from '../apps/launcher/launcher-app'
import { ALL_APPS } from '../apps/all-apps'
import type { AppContext, AppDefinition, AppLaunchParams } from '../apps/app-definition'
import { WorkerAppHost } from '../ui/shell/worker-window'
import { createInProcessWindow, YieldAtRootLayer, type InProcessAppOptions, type InProcessWindow } from '../ui/shell/in-process-window'
import { getStringSettingById } from '../ui/dashboard-settings'
import { readPhoneBatteryState } from '../native/phone-battery'
import { iosAppUnavailableReason } from '../apps/ios-availability'
import { SurfaceCompositor } from '../graphics/surface-compositor'
import { flattenPlanes, type Plane } from '../graphics/plane'
import { G2_LENS_WIDTH, G2_LENS_HEIGHT } from '../graphics/image'
import { previewPixels } from '../native/ios-graphics'
import { makeInputEvent, type InputEventPayload } from '../ui/gestures'
import { noopLayerActions, type LayerActions } from '../ui/layers'
import { TextViewerLayer } from '../apps/files/text-viewer'
import { shell, rawInputEventToInputEvent, type ShellWindow } from '../ui/shell/shell'
import { appViewportRect, SIDEBAR_WIDTH, sidebarStripVisible } from '../ui/shell/geometry'
import { DISPLAY_MODE_VALUES, displayModeLabel, displayModeSetting, onAnySettingChanged,
  previewColorSetting } from '../ui/dashboard-settings'
import type { PhoneGesture } from '../phone-ui/phone-gestures'

/** iOS host for the shared app registry, shell, compositor and BLE session. */
export class IosPreviewController {
  private readonly compositor = new SurfaceCompositor(G2_LENS_WIDTH, G2_LENS_HEIGHT)
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private offSettings: (() => void) | null = null
  private active = false
  private runtimeRunning = false
  private clockMinute = -1
  private shellDirty = true
  private inputQueue: Promise<void> = Promise.resolve()
  private lastLayout = ''
  private prompting = false
  private readonly appHosts = new Map<string, WorkerAppHost>()
  private readonly inProcessApps = new Map<string, InProcessWindow>()
  private readonly batteryObservers: any[] = []
  private session: GlassesSession | null = null
  private logLines: string[] = []
  private logTimer: ReturnType<typeof setTimeout> | null = null
  private readonly actions: LayerActions = {
    ...noopLayerActions,
    requestRender: () => this.requestShellRender(),
    disconnect: () => this.disconnect(),
    startVoiceCapture: () => this.typeIntoApp(),
    startContinuousVoiceCapture: () => this.onError("Voice capture is not available on iOS yet."),
    startTextSettingEdit: setting => this.editSetting(setting),
    startTextSettingsEdit: async (settings, _title, finished) => {
      for (const setting of settings) await this.editSetting(setting)
      finished?.()
    },
  }

  constructor(private readonly onFrame: (image: ImageSource, focus: string) => void,
    private readonly onError: (message: string) => void,
    private readonly onConnectionState: (state: SessionState) => void = () => {}) {
    this.compositor.configureSurface('shell', { x: 0, y: 0, width: 640, height: 480, zOrder: 1, transparency: 'color-key' })
    shell.configure({
      actions: this.actions,
      voiceInputEnabled: false,
      getScreenTimeoutMs: () => null,
      requestShellRender: () => this.requestShellRender(),
      onWindowsChanged: () => this.requestShellRender(),
      onScreenStateChanged: on => { this.compositor.setScreenBlanked(!on); this.requestShellRender() },
    })
    const launcher = createLauncherWindow({
      actions: this.actions,
      apps: () => ALL_APPS.filter(app => app.showInLauncher !== false).map(app => ({
        appId: app.appId, label: app.title, icon: app.icon, renderIcon: app.renderIcon,
      })),
      launchApp: id => this.launchApp(id),
      uninstallApp: () => {},
      submitFrame: planes => this.submit(LAUNCHER_SURFACE_ID, planes),
      setSurfaceVisible: visible => { this.compositor.setSurfaceVisible(LAUNCHER_SURFACE_ID, visible); this.scheduleFrame() },
    })
    this.configureWindow(launcher)
    shell.registerWindow(launcher)
    shell.wake('window')
    shell.focusWindow(launcher.windowId)
    for (const app of ALL_APPS) if (app.appId !== 'launcher' && !iosAppUnavailableReason(app.appId)) app.boot?.(this.buildAppContext(app))
  }

  resume(): void {
    if (this.active) return
    this.active = true
    this.syncRuntime()
    this.logBluetooth('Phone foreground')
    if (this.session) this.onConnectionState({ ...this.session.state })
    this.session?.wake()
    this.relayout()
    shell.foregroundWindow()?.requestRender()
    this.requestShellRender()
  }
  pause(): void {
    if (!this.active) return
    this.active = false
    // The phone preview is hidden; the glasses still own their screen and input.
    this.syncRuntime()
    this.logBluetooth(`Phone background; glasses ${this.session?.state.phase ?? 'disconnected'}`)
    this.flushBluetoothLog()
    this.session?.wake()
  }
  private get runtimeNeeded(): boolean {
    return this.active || !!this.session && ['connected', 'connecting', 'retrying', 'disconnecting'].includes(this.session.state.phase)
  }
  private syncRuntime(): void {
    const running = this.runtimeNeeded
    if (running === this.runtimeRunning) return
    this.runtimeRunning = running
    for (const window of shell.getWindows()) window.setScreenOn?.(running && shell.isScreenOn())
    if (!running) {
      this.offSettings?.(); this.offSettings = null
      for (const observer of this.batteryObservers.splice(0)) NSNotificationCenter.defaultCenter.removeObserver(observer)
      UIDevice.currentDevice.batteryMonitoringEnabled = false
      if (this.clockTimer !== null) clearInterval(this.clockTimer)
      if (this.renderTimer !== null) clearTimeout(this.renderTimer)
      this.clockTimer = this.renderTimer = null
      return
    }
    UIDevice.currentDevice.batteryMonitoringEnabled = true
    for (const name of [UIDeviceBatteryLevelDidChangeNotification, UIDeviceBatteryStateDidChangeNotification]) {
      this.batteryObservers.push(NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(name, null, NSOperationQueue.mainQueue, () => this.requestShellRender()))
    }
    const phone = readPhoneBatteryState()
    this.logBluetooth(`Phone battery ${phone.battery ?? "unknown"}% charging=${phone.charging}`)
    this.offSettings = onAnySettingChanged(() => {
      this.relayout()
      shell.foregroundWindow()?.requestRender()
      this.requestShellRender()
    })
    this.clockTimer = setInterval(() => this.refreshClock(), 60_000)
  }
  private refreshClock(): void {
    const minute = Math.floor(Date.now() / 60_000)
    if (minute !== this.clockMinute) { this.clockMinute = minute; this.requestShellRender() }
  }
  private configureWindow(window: ShellWindow): void {
    this.compositor.configureSurface(window.surfaceId, {
      ...appViewportRect(window.heightMode, window.appId), zOrder: 0, transparency: 'opaque',
    })
    this.compositor.setSurfaceVisible(window.surfaceId, shell.foregroundWindow()?.windowId === window.windowId)
  }
  private relayout(): void {
    const layout = shell.getWindows().map(window => JSON.stringify(appViewportRect(window.heightMode, window.appId))).join(";")
    if (layout === this.lastLayout) return
    this.lastLayout = layout
    for (const window of shell.getWindows()) {
      this.configureWindow(window)
      window.relayout?.()
    }
  }
  private async submit(id: string, planes: Plane[]): Promise<void> {
    const image = flattenPlanes(planes)
    this.compositor.submitSurfaceFrame(id, image.pixels, { x: 0, y: 0, width: image.width, height: image.height })
    this.scheduleFrame()
  }
  private requestShellRender(): void { this.shellDirty = true; this.scheduleFrame() }
  private scheduleFrame(): void {
    if (!this.runtimeNeeded || this.renderTimer !== null) return
    // Coalesce window/chrome updates into one glasses frame, capped at 30 fps.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      if (!this.runtimeNeeded) return
      try {
        if (this.shellDirty) {
          this.shellDirty = false
          const image = flattenPlanes(shell.paintSurface(), { width: 640, height: 480 })
          this.compositor.submitSurfaceFrame('shell', image.pixels, { x: 0, y: 0, width: 640, height: 480 })
          this.compositor.setUnderlayDim(1, shell.underlayDim())
        }
        const pixels = this.compositor.composite()
        this.session?.setFrame(pixels)
        if (this.active) {
          const image = previewPixels(pixels, 640, 480, previewColorSetting.get() === 'green')
          this.onFrame(image, `${shell.foregroundWindow()?.title ?? 'Apps'} · ${shell.getFocus() === 'sidebar' ? 'App switcher' : 'App'}`)
        }
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
      if (gesture === 'tap' && origin === 'mirror' && shell.isScreenOn()) {
        await this.mirrorTap(nx, ny)
      } else {
        let type: string = ({ tap: 'click', 'double-tap': 'double-click' } as Record<string, string>)[gesture] ?? gesture
        if (origin === 'ring' && type.startsWith('swipe-')) {
          if (type === 'swipe-left' || type === 'swipe-right') return
          type = type === 'swipe-up' ? 'scroll-up' : 'scroll-down'
        }
        const event = makeInputEvent({ type, source: origin === 'ring' ? 'ring' : 'watch' } as InputEventPayload)
        await shell.receiveInput(event)
        this.requestShellRender()
      }
      console.log(`[ios-preview] ${origin} ${gesture}: ${shell.describeInputTarget()}`)
    }).catch(error => this.fail(error))
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
    if (!app) return
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
  private buildAppContext(app: AppDefinition): AppContext {
    return {
      appId: app.appId, apps: ALL_APPS, actions: this.actions,
      launchApp: (id, params) => this.launchApp(id, params), uninstallApp: async () => {},
      launchInProcessApp: (id, surface, create) => this.launchInProcessApp(id, surface, create),
      ensureWorkerHost: create => this.ensureWorkerHost(app.appId, create),
      submitWindowFrame: (id, planes) => this.submit(id, planes),
      setWindowSurfaceVisible: (id, visible) => { this.compositor.setSurfaceVisible(id, visible); this.scheduleFrame() },
      requestShellRender: () => this.requestShellRender(), appendLog: message => console.log(`[ios-app] ${message}`),
      setTextEditorHost: () => {},
    }
  }
  private async launchInProcessApp(windowId: string, surfaceId: string,
    create: (options: InProcessAppOptions) => InProcessWindow): Promise<void> {
    const existing = this.inProcessApps.get(windowId)
    if (existing) { shell.focusWindow(windowId); existing.requestRender(); this.requestShellRender(); return }
    const app = create({
      actions: this.actions, submitFrame: planes => this.submit(surfaceId, planes),
      setSurfaceVisible: visible => { this.compositor.setSurfaceVisible(surfaceId, visible); this.scheduleFrame() },
      removeSurface: () => { this.compositor.removeSurface(surfaceId); this.scheduleFrame() },
      reconfigureSurface: () => { const window = shell.getWindows().find(w => w.windowId === windowId); if (window) this.configureWindow(window); this.requestShellRender() },
      onClosed: () => { this.inProcessApps.delete(windowId) },
    })
    this.inProcessApps.set(windowId, app)
    this.configureWindow(app.window)
    shell.registerWindow(app.window); shell.focusWindow(windowId)
    app.requestRender(); this.requestShellRender()
  }
  private ensureWorkerHost(appId: string, create: () => Worker): WorkerAppHost {
    const existing = this.appHosts.get(appId)
    if (existing) return existing
    const host = new WorkerAppHost({
      appId, worker: create(),
      configureSurface: async (id, visible, heightMode) => {
        this.compositor.configureSurface(id, { ...appViewportRect(heightMode, appId), zOrder: 0, transparency: 'opaque' })
        this.compositor.setSurfaceVisible(id, visible)
      },
      setSurfaceVisible: (id, visible) => { this.compositor.setSurfaceVisible(id, visible); this.scheduleFrame() },
      removeSurface: id => { this.compositor.removeSurface(id); this.scheduleFrame() },
      submitPixels: (id, pixels, width, height) => {
        this.compositor.submitSurfaceFrame(id, pixels, { x: 0, y: 0, width, height }); this.scheduleFrame()
      },
      requestShellRender: () => this.requestShellRender(),
      openSettings: section => { void this.launchApp('settings', { section }) },
      startTextSettingEdit: id => { const setting = getStringSettingById(id); if (setting) void this.editSetting(setting) },
      endTextSettingEdit: () => {},
      startTextInput: () => { void this.typeIntoApp() },
    })
    this.appHosts.set(appId, host)
    return host
  }
  cycleDisplayMode(): void {
    const values = DISPLAY_MODE_VALUES
    displayModeSetting.set(values[(values.indexOf(displayModeSetting.get()) + 1) % values.length])
  }
  get displayModeLabel(): string { return displayModeLabel(displayModeSetting.get()) }
  get connectionState(): SessionState | null { return this.session?.state ?? null }
  get connectionDetails(): string {
    const state = this.connectionState
    return state ? `${state.status}\nL: ${state.leftVersion || 'unknown'}\nR: ${state.rightVersion || 'unknown'}\nBattery: ${state.battery ?? '?'}%\nRing: ${state.ring ? 'connected' : 'disconnected'}\nFrames acknowledged: ${state.frames}\n${state.capabilities}\n\n${this.logLines.slice(-12).join('\n')}` : 'Preview only. Configure devices, then connect.'
  }
  async connect(): Promise<void> {
    if (!this.active) return
    const addresses = loadDeviceAddresses(), error = deviceAddressError(addresses)
    if (error) { this.onError(error); return }
    if (!this.session) {
      const { deflate } = require('pako') as { deflate: (data: Uint8Array) => Uint8Array }
      this.session = new GlassesSession(iosBluetooth(), deflate, state => {
        shell.setBatteryLevels({ headset: state.battery, headsetCharging: state.charging })
        this.syncRuntime()
        if (this.active) this.onConnectionState(state)
        this.requestShellRender()
      }, input => {
        this.inputQueue = this.inputQueue.then(async () => {
          if (this.session?.state.phase !== 'connected') return
          await shell.receiveInput(rawInputEventToInputEvent(input)); this.requestShellRender()
          this.logBluetooth(`Input ${input.eventType} source ${input.eventSource}`)
        }).catch(error => this.fail(error))
      }, message => this.logBluetooth(message), () => this.refreshClock())
    }
    await this.session.start(addresses)
  }
  async disconnect(): Promise<void> { await this.session?.stop() }
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
  async typeIntoApp(): Promise<void> {
    if (!this.active) { this.logBluetooth('Text input requires opening Faceclaw on the phone'); return }
    if (this.prompting || !shell.foregroundWindow()?.receiveTextInput) return
    this.prompting = true
    try {
      const result = await Dialogs.prompt({ title: 'Type into ' + shell.foregroundWindow()?.title,
        message: 'Enter text to send to this app.', okButtonText: 'Send', cancelButtonText: 'Cancel' })
      if (result.result) shell.sendTextToForegroundWindow(result.text)
    } catch (error) { this.fail(error) }
    finally { this.prompting = false }
  }
  private async editSetting(setting: { editorTitle: string; get(): string; set(value: string): void }): Promise<void> {
    if (!this.active) { this.logBluetooth('Editing text settings requires opening Faceclaw on the phone'); return }
    const result = await Dialogs.prompt({ title: setting.editorTitle, defaultText: setting.get(), okButtonText: 'Save', cancelButtonText: 'Cancel' })
    if (result.result) setting.set(result.text)
  }
}
