import { Application, Button, Color, GridLayout, Image, Label, Page, StackLayout, type TouchGestureEventData } from '@nativescript/core'
import { IosPreviewController } from '../g2/ios-preview-controller'
import { PhoneGestureRecognizer } from './phone-gestures'
import { onAnySettingChanged, previewColorSetting } from '../ui/dashboard-settings'

export function createMainPage(): Page {
  const page = new Page()
  page.actionBarHidden = true
  const root = new GridLayout()
  root.rows = 'auto,*'
  page.content = root
  const header = new GridLayout()
  header.columns = '*,auto'; header.padding = '12 20'
  const title = new Label()
  title.text = 'Faceclaw'; title.fontSize = 25; title.fontWeight = 'bold'
  header.addChild(title)
  const state = new Label()
  state.text = 'Preview only'; state.fontSize = 14; state.verticalAlignment = 'middle'
  GridLayout.setColumn(state, 1); header.addChild(state); root.addChild(header)
  const body = new GridLayout()
  GridLayout.setRow(body, 1); root.addChild(body)
  const mirror = new Image()
  mirror.stretch = 'fill'; mirror.backgroundColor = new Color('black')
  mirror.accessibilityIdentifier = 'glasses-preview'
  mirror.accessibilityLabel = 'Interactive glasses screen preview'
  mirror.verticalAlignment = 'middle'; body.addChild(mirror)
  const controls = new GridLayout()
  controls.rows = 'auto,*,auto'; controls.padding = 16; body.addChild(controls)
  const tabs = new GridLayout()
  tabs.columns = '*,*,*'; controls.addChild(tabs)
  const pad = new GridLayout()
  pad.borderRadius = 18; pad.backgroundColor = new Color('#202522')
  pad.verticalAlignment = 'middle'; pad.horizontalAlignment = 'center'
  pad.accessibilityIdentifier = 'gesture-pad'
  GridLayout.setRow(pad, 1); controls.addChild(pad)
  const focus = new Label()
  focus.color = new Color('#ffffff'); focus.fontSize = 22; focus.textWrap = true
  focus.textAlignment = 'center'; focus.margin = 18; focus.verticalAlignment = 'middle'
  focus.isUserInteractionEnabled = false; pad.addChild(focus)
  const legend = new Label()
  legend.color = new Color('#b8c1bb'); legend.fontSize = 12; legend.textAlignment = 'center'
  legend.textWrap = true; legend.margin = 12; legend.verticalAlignment = 'bottom'
  legend.isUserInteractionEnabled = false; pad.addChild(legend)
  const settings = new StackLayout()
  settings.verticalAlignment = 'middle'
  GridLayout.setRow(settings, 1); controls.addChild(settings)
  const errorLabel = new Label()
  errorLabel.textWrap = true; errorLabel.color = new Color('#a02d2d'); errorLabel.visibility = 'collapse'
  settings.addChild(errorLabel)
  let selectedTab: 'watch' | 'ring' | 'settings' = 'watch'
  const controller = new IosPreviewController((image, label) => {
    mirror.imageSource = image; focus.text = selectedTab === 'ring' ? 'Ring' : label
  }, message => {
    errorLabel.text = message; errorLabel.visibility = 'visible'; selectTab('settings')
  })
  const padInput = new PhoneGestureRecognizer(gesture => controller.gesture(gesture, selectedTab === 'ring' ? 'ring' : 'watch'))
  const mirrorInput = new PhoneGestureRecognizer((gesture, x, y) => {
    const size = mirror.getActualSize()
    if (size.width > 0 && size.height > 0) controller.gesture(gesture, 'mirror', x / size.width, y / size.height)
  })
  const touch = (recognizer: PhoneGestureRecognizer) => (event: TouchGestureEventData) => {
    if (!['down', 'move', 'up', 'cancel'].includes(event.action)) return
    recognizer.touch({ action: event.action as 'down' | 'move' | 'up' | 'cancel', x: event.getX(), y: event.getY(), pointers: event.getPointerCount() })
  }
  pad.on('touch', touch(padInput)); mirror.on('touch', touch(mirrorInput))
  function button(text: string, action: () => void): Button {
    const view = new Button()
    view.text = text; view.fontSize = 15; view.margin = 3; view.on('tap', action)
    return view
  }
  const tabButtons: Button[] = []
  function selectTab(tab: typeof selectedTab): void {
    padInput.cancel(); selectedTab = tab
    pad.visibility = tab === 'settings' ? 'collapse' : 'visible'
    settings.visibility = tab === 'settings' ? 'visible' : 'collapse'
    for (let i = 0; i < tabButtons.length; i++) tabButtons[i].opacity = ['settings', 'watch', 'ring'][i] === tab ? 1 : 0.5
    focus.text = tab === 'ring' ? 'Ring' : 'Watch controls'
    legend.text = tab === 'ring' ? 'Swipe up/down · Tap to select\nDouble-tap: back · Hold: menu' : 'Swipe to navigate · Tap to select\nDouble-tap / two fingers: back · Hold: menu'
    layout()
  }
  for (const [index, tab] of (['settings', 'watch', 'ring'] as const).entries()) {
    const view = button(tab[0].toUpperCase() + tab.slice(1), () => selectTab(tab))
    GridLayout.setColumn(view, index); tabs.addChild(view); tabButtons.push(view)
  }
  const sizeButton = button(controller.displayModeLabel, () => controller.cycleDisplayMode())
  settings.addChild(sizeButton)
  settings.addChild(button('Toggle green / grayscale', () => previewColorSetting.set(previewColorSetting.get() === 'green' ? 'white' : 'green')))
  const help = new Label()
  help.text = 'Tap preview icons to open apps.\nHold: system menu\nTap then hold: app menu'
  help.fontSize = 13; help.textWrap = true; help.margin = 6; settings.addChild(help)
  const footer = new GridLayout()
  footer.columns = '*,*,*'; GridLayout.setRow(footer, 2); controls.addChild(footer)
  const back = button('Back', () => controller.gesture('double-tap', 'watch'))
  const menu = button('Menu', () => {
    controller.gesture('long-press', 'watch'); controller.gesture('long-press-release', 'watch')
  })
  const keyboard = button('Keyboard', () => { void controller.typeIntoApp() })
  for (const [index, view] of [back, menu, keyboard].entries()) {
    view.padding = '16 8'; view.fontSize = 14
    GridLayout.setColumn(view, index); footer.addChild(view)
  }
  let lastLayout = ''
  function layout(): void {
    const size = root.getActualSize()
    if (size.width <= 0 || size.height <= 0) return
    const key = `${size.width}:${size.height}:${selectedTab}`
    if (key === lastLayout) return
    lastLayout = key; padInput.cancel(); mirrorInput.cancel()
    const landscape = size.width > size.height
    body.rows = landscape ? '*' : 'auto,*'; body.columns = landscape ? '*,320' : '*'
    GridLayout.setRow(controls, landscape ? 0 : 1); GridLayout.setColumn(controls, landscape ? 1 : 0)
    const width = landscape ? Math.min(size.width - 320, (size.height - 64) * 4 / 3) : size.width
    mirror.width = width; mirror.height = width * 3 / 4
    pad.width = selectedTab === 'ring' ? 150 : Math.min(360, (landscape ? 320 : size.width) - 32)
    pad.height = Math.max(120, Math.min(250, size.height - (landscape ? 180 : width * 3 / 4 + 200)))
  }
  // iOS emits layoutChanged inside its layout pass. Defer mutations so
  // NativeScript does not clear our new layout request at the end of that pass.
  let layoutTimer: ReturnType<typeof setTimeout> | null = null
  root.on('layoutChanged', () => {
    if (layoutTimer !== null) return
    layoutTimer = setTimeout(() => { layoutTimer = null; layout() }, 0)
  })
  const pause = () => {
    if (layoutTimer !== null) clearTimeout(layoutTimer)
    layoutTimer = null
    padInput.cancel(); mirrorInput.cancel(); controller.pause()
  }
  const resume = () => controller.resume()
  let offSettings: (() => void) | null = null
  page.on('loaded', () => {
    Application.on(Application.suspendEvent, pause); Application.on(Application.resumeEvent, resume)
    offSettings?.(); offSettings = onAnySettingChanged(() => { sizeButton.text = controller.displayModeLabel })
    selectTab(selectedTab); controller.resume()
  })
  page.on('unloaded', () => {
    pause(); offSettings?.(); offSettings = null
    Application.off(Application.suspendEvent, pause); Application.off(Application.resumeEvent, resume)
  })
  return page
}
