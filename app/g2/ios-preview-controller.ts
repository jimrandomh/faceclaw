import { Dialogs, File, knownFolders, path, type ImageSource } from '@nativescript/core'
import { iosBluetooth } from '../native/ios-bluetooth'
import { GlassesSession, type SessionState } from './glasses-session'
import { loadDeviceAddresses } from './device-addresses'
import { deviceAddressError } from './ios-peripheral-identity'
import { createLauncherWindow, LAUNCHER_SURFACE_ID } from '../apps/launcher/launcher-app'
import { CalculatorLayer } from '../apps/calculator/calculator'
import { MathCoordinator } from '../apps/calculator/math/coordinator'
import { SurfaceCompositor } from '../graphics/surface-compositor'
import { flattenPlanes, type Plane } from '../graphics/plane'
import { G2_LENS_WIDTH, G2_LENS_HEIGHT } from '../graphics/image'
import { previewPixels } from '../native/ios-graphics'
import { makeInputEvent, type InputEventPayload } from '../ui/gestures'
import { noopLayerActions, type LayerActions } from '../ui/layers'
import { MenuLayer } from '../ui/menu'
import { createInProcessWindow } from '../ui/shell/in-process-window'
import { shell, rawInputEventToInputEvent, type ShellWindow } from '../ui/shell/shell'
import { appViewportRect, SIDEBAR_WIDTH, sidebarStripVisible } from '../ui/shell/geometry'
import { DISPLAY_MODE_VALUES, displayModeLabel, displayModeSetting, onAnySettingChanged,
  previewColorSetting, timeFormatSetting, verticalPositionSetting } from '../ui/dashboard-settings'
import type { PhoneGesture } from '../phone-ui/phone-gestures'

/** Local display host: shared shell/windows, no device-service initialization. */
export class IosPreviewController {
  private readonly compositor = new SurfaceCompositor(G2_LENS_WIDTH, G2_LENS_HEIGHT)
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private offSettings: (() => void) | null = null
  private active = false
  private shellDirty = true
  private inputQueue: Promise<void> = Promise.resolve()
  private lastLayout = ''
  private prompting = false
  private session: GlassesSession | null = null
  private resumeConnection = false
  private suspendedDisconnect: Promise<void> = Promise.resolve()
  private logLines: string[] = []
  private logTimer: ReturnType<typeof setTimeout> | null = null
  private readonly actions: LayerActions = {
    ...noopLayerActions,
    requestRender: () => this.requestShellRender(),
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
      apps: () => [
        { appId: 'calculator', label: 'Calculator', icon: 'calculator' },
        { appId: 'display', label: 'Display', icon: 'settings' },
      ],
      launchApp: id => this.launchApp(id),
      uninstallApp: () => {},
      submitFrame: planes => this.submit(LAUNCHER_SURFACE_ID, planes),
      setSurfaceVisible: visible => { this.compositor.setSurfaceVisible(LAUNCHER_SURFACE_ID, visible); this.scheduleFrame() },
    })
    this.configureWindow(launcher)
    shell.registerWindow(launcher)
    shell.wake('window')
    shell.focusWindow(launcher.windowId)
  }

  resume(): void {
    if (this.active) return
    this.active = true
    this.offSettings = onAnySettingChanged(() => {
      this.relayout()
      shell.foregroundWindow()?.requestRender()
      this.requestShellRender()
    })
    this.clockTimer = setInterval(() => this.requestShellRender(), 60_000)
    this.relayout()
    shell.foregroundWindow()?.requestRender()
    this.requestShellRender()
    console.log('[ios-preview] Main screen active')
    if (this.resumeConnection) {
      this.resumeConnection = false
      void this.suspendedDisconnect.then(() => { if (this.active) void this.connect() })
    }
  }
  pause(): void {
    this.resumeConnection = !!this.session && ['connected', 'connecting', 'retrying'].includes(this.session.state.phase)
    if (this.session) this.suspendedDisconnect = this.session.stop()
    this.active = false
    this.offSettings?.(); this.offSettings = null
    if (this.clockTimer) clearInterval(this.clockTimer)
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.clockTimer = this.renderTimer = null
  }
  private configureWindow(window: ShellWindow): void {
    this.compositor.configureSurface(window.surfaceId, {
      ...appViewportRect(window.heightMode, window.appId), zOrder: 0, transparency: 'opaque',
    })
    this.compositor.setSurfaceVisible(window.surfaceId, shell.foregroundWindow()?.windowId === window.windowId)
  }
  private relayout(): void {
    const layout = `${displayModeSetting.get()}:${verticalPositionSetting.get()}`
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
    if (!this.active || this.renderTimer !== null) return
    // Coalesce window/chrome updates into one preview, capped at 30 fps.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      try {
        if (this.shellDirty) {
          this.shellDirty = false
          const image = flattenPlanes(shell.paintSurface(), { width: 640, height: 480 })
          this.compositor.submitSurfaceFrame('shell', image.pixels, { x: 0, y: 0, width: 640, height: 480 })
          this.compositor.setUnderlayDim(1, shell.underlayDim())
        }
        const pixels = this.compositor.composite()
        this.session?.setFrame(pixels)
        const image = previewPixels(pixels, 640, 480, previewColorSetting.get() === 'green')
        this.onFrame(image, `${shell.foregroundWindow()?.title ?? 'Apps'} · ${shell.getFocus() === 'sidebar' ? 'App switcher' : 'App'}`)
      } catch (error) { this.fail(error) }
    }, 33)
  }
  private fail(error: unknown): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(`[ios-preview] ${message}`)
    this.onError(error instanceof Error ? error.message : String(error))
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
  launchApp(id: string): void {
    const existing = shell.getWindows().find(window => window.appId === id)
    if (existing) { shell.focusWindow(existing.windowId); existing.requestRender(); this.requestShellRender(); return }
    const surfaceId = `window:${id}`
    let render = () => {}
    const actions = { ...this.actions, requestRender: () => render() }
    const layer = id === 'calculator'
      ? new CalculatorLayer(new MathCoordinator(), actions, () => this.typeIntoApp())
      : new MenuLayer('Display', [
        { label: 'Change screen size', onSelect: () => this.cycleDisplayMode() },
        { label: 'Toggle green / grayscale preview', onSelect: () => { previewColorSetting.set(previewColorSetting.get() === 'green' ? 'white' : 'green') } },
        { label: 'Toggle 12 / 24 hour clock', onSelect: () => { timeFormatSetting.set(timeFormatSetting.get() === '24h' ? '12h' : '24h') } },
      ], { x: 8, y: 8, width: 320, minHeight: 160, opaque: true })
    const app = createInProcessWindow({
      appId: id, windowId: id, title: id === 'calculator' ? 'Calculator' : 'Display',
      iconLetter: id === 'calculator' ? '=' : 'D', icon: id === 'calculator' ? 'calculator' : 'settings',
      closeable: true, actions, baseLayer: layer,
      receiveTextInput: id === 'calculator' ? text => { app.stack.receiveTextInput(text); app.requestRender() } : undefined,
      submitFrame: planes => this.submit(surfaceId, planes),
      setSurfaceVisible: visible => {
        if (layer instanceof CalculatorLayer) layer.setForeground(visible)
        this.compositor.setSurfaceVisible(surfaceId, visible); this.scheduleFrame()
      },
      removeSurface: () => { this.compositor.removeSurface(surfaceId); this.scheduleFrame() },
      onClosed: () => { if (layer instanceof CalculatorLayer) layer.onRemoved() },
    })
    render = app.requestRender
    if (layer instanceof CalculatorLayer) layer.requestRender = render
    this.configureWindow(app.window)
    shell.registerWindow(app.window)
    shell.focusWindow(app.window.windowId)
    app.requestRender(); this.requestShellRender()
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
        this.onConnectionState(state)
        if (state.phase === 'connected') this.requestShellRender()
      }, input => {
        this.inputQueue = this.inputQueue.then(async () => {
          if (!this.active) return
          await shell.receiveInput(rawInputEventToInputEvent(input)); this.requestShellRender()
          this.logBluetooth(`Input ${input.eventType} source ${input.eventSource}`)
        }).catch(error => this.fail(error))
      }, message => this.logBluetooth(message))
    }
    await this.session.start(addresses)
  }
  async disconnect(): Promise<void> { this.resumeConnection = false; await this.session?.stop() }
  private logBluetooth(message: string): void {
    const line = `${new Date().toISOString()} ${message}`
    console.log(`[ios-ble] ${line}`); this.logLines.push(line)
    if (this.logLines.length > 200) this.logLines.shift()
    if (this.logTimer !== null) return
    this.logTimer = setTimeout(() => {
      this.logTimer = null
      try { File.fromPath(path.join(knownFolders.documents().path, 'bluetooth.log')).writeTextSync(this.logLines.join('\n')) }
      catch (error) { console.warn(`Bluetooth log: ${error}`) }
    }, 500)
  }
  async typeIntoApp(): Promise<void> {
    if (this.prompting || !shell.foregroundWindow()?.receiveTextInput) return
    this.prompting = true
    try {
      const result = await Dialogs.prompt({ title: 'Type into ' + shell.foregroundWindow()?.title,
        message: 'Enter an expression or follow-up.', okButtonText: 'Send', cancelButtonText: 'Cancel' })
      if (result.result) shell.sendTextToForegroundWindow(result.text)
    } catch (error) { this.fail(error) }
    finally { this.prompting = false }
  }
  private async editSetting(setting: { editorTitle: string; get(): string; set(value: string): void }): Promise<void> {
    const result = await Dialogs.prompt({ title: setting.editorTitle, defaultText: setting.get(), okButtonText: 'Save', cancelButtonText: 'Cancel' })
    if (result.result) setting.set(result.text)
  }
}
