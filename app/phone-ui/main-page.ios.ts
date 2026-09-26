import { KeyboardInputViewModel } from './keyboard-input-view-model'
import { Application, Builder, Button, Color, Dialogs, Frame, GridLayout, Image, Label, Page, TextView, type PropertyChangeData, type TouchGestureEventData, type View } from '@nativescript/core'
import { isPreviewOnlyMode } from './onboarding-state'
import { isAutoReconnectSuppressed, resumeAutoReconnect, suppressAutoReconnect } from '../g2/reconnect-policy'
import { RemoteControlsViewModel } from './remote-controls-view-model'
import { IosPreviewController } from '../g2/ios-preview-controller'
import { PhoneGestureRecognizer } from './phone-gestures'
import { BleBandwidthMeter } from './ble-bandwidth-meter'
import { sampleBleTraffic } from '../native/ble-traffic'
import { onAnySettingChanged, mirrorTouchSetting, showBleBandwidthSetting } from '../ui/dashboard-settings'
import { loadDeviceAddresses } from '../g2/device-addresses'
import { deviceAddressError } from '../g2/ios-peripheral-identity'

export function createMainPage(): Page {
  const page = new Page()
  page.actionBarHidden = true
  page.className = 'main-page'
  page.iosOverflowSafeAreaEnabled = false
  const root = new GridLayout()
  root.rows = 'auto,*'
  page.content = root
  const header = new GridLayout()
  header.columns = '*,auto,auto'; header.className = 'main-header'
  const title = new Label()
  title.text = 'Faceclaw'; title.className = 'action-bar-title'
  header.addChild(title)
  const state = new Label()
  state.text = 'Preview'; state.className = 'action-bar-status'
  state.verticalAlignment = 'middle'
  state.on('tap', () => { void openDevices() })
  GridLayout.setColumn(state, 1); header.addChild(state)
  const overflow = new Button()
  overflow.text = '⋮'; overflow.accessibilityLabel = 'More options'; overflow.className = 'overflow-button'
  overflow.on('tap', () => openMenu())
  GridLayout.setColumn(overflow, 2); header.addChild(overflow); root.addChild(header)
  const body = new GridLayout()
  GridLayout.setRow(body, 1); root.addChild(body)
  const mirror = new Image()
  mirror.stretch = 'fill'; mirror.backgroundColor = new Color('black')
  mirror.accessibilityIdentifier = 'glasses-preview'
  mirror.accessibilityLabel = 'Interactive glasses screen preview'
  mirror.horizontalAlignment = 'left'; mirror.verticalAlignment = 'middle'; body.addChild(mirror)
  // Load exactly the same XML and binding model as Android. Only input dispatch
  // and the surrounding platform navigation/runtime remain iOS-specific.
  const model = new RemoteControlsViewModel()
  const controls = new GridLayout()
  const remote = Builder.load('~/phone-ui/remote-controls')
  remote.bindingContext = model
  controls.addChild(remote); body.addChild(controls)
  const keyboardModel = new KeyboardInputViewModel()
  const keyboardPanel = Builder.load('~/phone-ui/keyboard-input-panel')
  keyboardPanel.bindingContext = keyboardModel
  GridLayout.setRow(keyboardPanel, 1); root.addChild(keyboardPanel)
  let focusTimer: ReturnType<typeof setTimeout> | null = null
  const keyboardField = () => keyboardPanel.getViewById<TextView>('keyboardInputField')
  const controller = new IosPreviewController((image, label) => {
    mirror.imageSource = image; model.set('padFocusLine', label)
  }, message => {
    void Dialogs.alert({ title: 'Faceclaw', message, okButtonText: 'OK' })
  }, connection => {
    state.text = ({ connected: 'Connected', disconnected: 'Preview', connecting: 'Connecting',
      retrying: 'Reconnecting', disconnecting: 'Disconnecting', error: 'Failed' })[connection.phase]
  }, session => {
    keyboardModel.setSession(session)
    controls.visibility = session ? 'collapse' : 'visible'
    if (focusTimer !== null) clearTimeout(focusTimer)
    focusTimer = null
    if (session) {
      focusTimer = setTimeout(() => { focusTimer = null; keyboardField()?.focus() }, 0)
    } else keyboardField()?.dismissSoftInput()
  })
  async function navigateDevicePage(moduleName: string, context?: object): Promise<void> {
    suppressAutoReconnect()
    await controller.disconnect()
    Frame.topmost()?.navigate({ moduleName, context })
  }
  function openMenu(): void {
    const connected = ['connected', 'connecting', 'retrying'].includes(controller.connectionState?.phase ?? '')
    const configured = !deviceAddressError(loadDeviceAddresses())
    const menu = UIAlertController.alertControllerWithTitleMessagePreferredStyle(null, null, UIAlertControllerStyle.ActionSheet)
    const add = (label: string, action: (() => void) | null) => {
      const item = UIAlertAction.actionWithTitleStyleHandler(label, UIAlertActionStyle.Default, () => {
        // Finish dismissal before presenting a share sheet or another page.
        menu.dismissViewControllerAnimatedCompletion(true, () => action?.())
      })
      item.enabled = action !== null
      menu.addAction(item)
    }
    if (configured) add(connected ? 'Disconnect' : 'Connect', () => {
      if (connected) { suppressAutoReconnect(); void controller.disconnect() }
      else { resumeAutoReconnect(); void controller.connect() }
    })
    add('Pair glasses', () => { void navigateDevicePage('phone-ui/onboarding-unpair-page') })
    add('Permissions', () => Frame.topmost()?.navigate({ moduleName: 'phone-ui/permissions-page' }))
    // Keep Android's menu order/text. These services still require Android;
    // disabled items make the platform limitation visible without dead actions.
    add('Conversations', null)
    add('Take screenshot', mirror.imageSource ? () => {
      const share = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities([mirror.imageSource.ios], null)
      if (share.popoverPresentationController) {
        share.popoverPresentationController.sourceView = overflow.ios
        share.popoverPresentationController.sourceRect = overflow.ios.bounds
      }
      page.ios.presentViewControllerAnimatedCompletion(share, true, null)
    } : null)
    add('Record screen', null)
    if (configured) add('Uninstall custom firmware', () => {
      void navigateDevicePage('phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false })
    })
    menu.addAction(UIAlertAction.actionWithTitleStyleHandler('Cancel', UIAlertActionStyle.Cancel, null))
    if (menu.popoverPresentationController) {
      menu.popoverPresentationController.sourceView = overflow.ios
      menu.popoverPresentationController.sourceRect = overflow.ios.bounds
    }
    page.ios.presentViewControllerAnimatedCompletion(menu, true, null)
  }
  async function openDevices(): Promise<void> {
    const connected = ['connected', 'connecting', 'retrying'].includes(controller.connectionState?.phase ?? '')
    const choice = await Dialogs.action({ title: 'Connection status', message: controller.connectionState?.status ?? 'Preview only', cancelButtonText: 'Cancel',
      actions: ['Pair glasses', 'Configure devices', connected ? 'Disconnect' : 'Connect', 'Check firmware', 'Install custom firmware', 'Uninstall custom firmware', 'Connection details'] })
    if (['Pair glasses', 'Configure devices', 'Check firmware', 'Install custom firmware', 'Uninstall custom firmware'].includes(choice)) {
      suppressAutoReconnect()
      await controller.disconnect()
      if (choice === 'Pair glasses') {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/onboarding-unpair-page' })
      } else if (choice === 'Configure devices') {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/config-page', context: { onboarding: isPreviewOnlyMode() } })
      } else if (choice === 'Check firmware') {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/onboarding-firmware-check-page' })
      } else {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/onboarding-flash-page', context: { mode: choice === 'Uninstall custom firmware' ? 'uninstall' : 'install', fromOnboarding: false } })
      }
    } else if (choice === 'Connect') { resumeAutoReconnect(); await controller.connect() }
    else if (choice === 'Disconnect') { suppressAutoReconnect(); await controller.disconnect() }
    else if (choice === 'Connection details') await Dialogs.alert({ title: 'Connection details', message: controller.connectionDetails, okButtonText: 'OK' })
  }
  const watchInput = new PhoneGestureRecognizer(gesture => controller.gesture(gesture, 'watch'))
  const ringInput = new PhoneGestureRecognizer(gesture => controller.gesture(gesture, 'ring'))
  const mirrorInput = new PhoneGestureRecognizer((gesture, x, y) => {
    if (!mirrorTouchSetting.get()) return
    const size = mirror.getActualSize()
    if (size.width > 0 && size.height > 0) controller.gesture(gesture, 'mirror', x / size.width, y / size.height)
  })
  const touch = (recognizer: PhoneGestureRecognizer) => (event: TouchGestureEventData) => {
    if (!['down', 'move', 'up', 'cancel'].includes(event.action)) return
    recognizer.touch({ action: event.action as 'down' | 'move' | 'up' | 'cancel', x: event.getX(), y: event.getY(), pointers: event.getPointerCount() })
  }
  model.set('onPadTouch', touch(watchInput))
  model.set('onRingPadTouch', touch(ringInput))
  model.set('onSyntheticMicTap', () => controller.startVoiceInput())
  model.set('onKeyboardTap', () => { void controller.typeIntoApp() })
  mirror.on('touch', touch(mirrorInput))
  const cancelGestures = () => { watchInput.cancel(); ringInput.cancel(); mirrorInput.cancel() }
  model.on('propertyChange', (args: PropertyChangeData) => {
    if (args.propertyName === 'watchTabVisibility') cancelGestures()
  })
  let controlsLayoutTimer: ReturnType<typeof setTimeout> | null = null
  model.set('onControlsContentLayoutChanged', (args: { object: View }) => {
    if (controlsLayoutTimer !== null) clearTimeout(controlsLayoutTimer)
    // Defer binding updates out of UIKit's layout pass.
    controlsLayoutTimer = setTimeout(() => {
      controlsLayoutTimer = null
      const { width, height } = args.object.getActualSize()
      model.set('watchFaceWidth', Math.min(345, Math.max(0, width)))
      model.set('watchFaceHeight', Math.min(230, Math.max(0, height - 2)))
      model.set('ringTouchpadHeight', Math.min(250, Math.max(0, height - 2)))
    }, 0)
  })
  const bandwidth = new Label()
  bandwidth.accessibilityIdentifier = 'ble-bandwidth-indicator'
  bandwidth.className = 'ble-bandwidth-indicator'; bandwidth.isUserInteractionEnabled = false
  bandwidth.horizontalAlignment = 'center'; bandwidth.verticalAlignment = 'bottom'
  bandwidth.visibility = 'collapse'
  GridLayout.setRow(bandwidth, 1); root.addChild(bandwidth)
  const bandwidthMeter = new BleBandwidthMeter()
  let bandwidthTimer: ReturnType<typeof setInterval> | null = null
  let foreground = false
  function stopBandwidth(): void {
    if (bandwidthTimer !== null) clearInterval(bandwidthTimer)
    bandwidthTimer = null; bandwidthMeter.reset()
  }
  function syncBandwidth(): void {
    if (!foreground) { stopBandwidth(); return }
    const enabled = showBleBandwidthSetting.get()
    bandwidth.visibility = enabled ? 'visible' : 'collapse'
    if (!enabled) { stopBandwidth(); return }
    if (bandwidthTimer !== null) return
    const refresh = () => { bandwidth.text = bandwidthMeter.sample(sampleBleTraffic(), Date.now()) }
    refresh(); bandwidthTimer = setInterval(refresh, 1000)
  }
  let lastLayout = ''
  function layout(): void {
    const size = body.getActualSize()
    if (size.width <= 0 || size.height <= 0) return
    const landscape = root.getActualSize().width > root.getActualSize().height
    const key = `${size.width}:${size.height}:${landscape}`
    if (key === lastLayout) return
    lastLayout = key; cancelGestures()
    body.className = landscape ? 'landscape-layout' : ''
    root.className = landscape ? 'main-landscape' : ''
    body.rows = landscape ? '*' : 'auto,*'; body.columns = landscape ? '*,345' : '*'
    controls.padding = landscape ? 0 : 20
    GridLayout.setRow(controls, landscape ? 0 : 1); GridLayout.setColumn(controls, landscape ? 1 : 0)
    const width = landscape ? Math.max(0, Math.min(size.width - 345, size.height * 4 / 3)) : size.width
    mirror.width = width; mirror.height = width * 3 / 4
  }
  // iOS emits layoutChanged inside its layout pass. Defer mutations so
  // NativeScript does not clear our new layout request at the end of that pass.
  let layoutTimer: ReturnType<typeof setTimeout> | null = null
  body.on('layoutChanged', () => {
    if (layoutTimer !== null) return
    layoutTimer = setTimeout(() => { layoutTimer = null; layout() }, 0)
  })
  const pause = () => {
    foreground = false; stopBandwidth()
    if (layoutTimer !== null) clearTimeout(layoutTimer)
    layoutTimer = null
    if (controlsLayoutTimer !== null) clearTimeout(controlsLayoutTimer)
    controlsLayoutTimer = null
    if (focusTimer !== null) clearTimeout(focusTimer)
    focusTimer = null
    keyboardField()?.dismissSoftInput()
    cancelGestures(); controller.pause()
  }
  const resume = () => { foreground = true; controller.resume(); syncBandwidth() }
  let keyboardObserver: any = null
  let offSettings: (() => void) | null = null
  page.on('loaded', () => {
    if (!keyboardObserver) keyboardObserver = NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
      UIKeyboardWillChangeFrameNotification, null, NSOperationQueue.mainQueue, notification => {
        const frame = notification.userInfo.objectForKey(UIKeyboardFrameEndUserInfoKey).CGRectValue
        const view = page.ios.view
        const local = view.convertRectFromView(frame, null)
        root.paddingBottom = Math.max(0, view.bounds.size.height - local.origin.y - view.safeAreaInsets.bottom)
      })
    Application.on(Application.suspendEvent, pause); Application.on(Application.resumeEvent, resume)
    offSettings?.(); offSettings = onAnySettingChanged(() => { model.refreshDisplayControls(); syncBandwidth() })
    model.refreshDisplayControls(); resume()
    if (!isPreviewOnlyMode() && !isAutoReconnectSuppressed() && !deviceAddressError(loadDeviceAddresses())) void controller.connect()
  })
  page.on('unloaded', () => {
    if (keyboardObserver) NSNotificationCenter.defaultCenter.removeObserver(keyboardObserver)
    keyboardObserver = null
    root.paddingBottom = 0
    pause(); offSettings?.(); offSettings = null
    Application.off(Application.suspendEvent, pause); Application.off(Application.resumeEvent, resume)
  })
  return page
}

export const createPage = createMainPage
