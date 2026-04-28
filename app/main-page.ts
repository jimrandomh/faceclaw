import { Color, EventData, isAndroid, Observable, Page, ScrollView, TextField } from '@nativescript/core'
import { MainViewModel } from './main-view-model'
import { dashboardController } from './g2/dashboard-controller'

const SETTINGS_TEXT_COLOR = new Color('#222222')
const SETTINGS_BACKGROUND_COLOR = new Color('#ffffff')
const SETTINGS_PLACEHOLDER_COLOR = new Color('#666666')

export function navigatingTo(args: EventData) {
  const page = <Page>args.object
  page.bindingContext = new MainViewModel()
}

type MainPageState = {
  isPinnedToBottom: boolean
  scrollHandler: () => void
  propertyChangeHandler: (args: EventData & { propertyName?: string }) => void
}

function getPageState(page: Page): MainPageState | undefined {
  return (page as Page & { __mainPageState?: MainPageState }).__mainPageState
}

function setPageState(page: Page, state?: MainPageState): void {
  ;(page as Page & { __mainPageState?: MainPageState }).__mainPageState = state
}

function cleanupPage(page: Page): void {
  const state = getPageState(page)
  const model = page.bindingContext as MainViewModel | null
  const scrollView = page.getViewById<ScrollView>('logScrollView')
  if (!state || !model || !scrollView) {
    setPageState(page, undefined)
    return
  }
  scrollView.off(ScrollView.scrollEvent, state.scrollHandler)
  model.off(Observable.propertyChangeEvent, state.propertyChangeHandler)
  setPageState(page, undefined)
}

function isAtBottom(scrollView: ScrollView): boolean {
  return scrollView.scrollableHeight <= 0 || scrollView.verticalOffset >= scrollView.scrollableHeight - 8
}

function scrollToBottom(scrollView: ScrollView): void {
  setTimeout(() => {
    scrollView.scrollToVerticalOffset(scrollView.scrollableHeight, false)
  }, 0)
}

function applySettingsTextFieldContrast(textField: TextField): void {
  textField.color = SETTINGS_TEXT_COLOR
  textField.backgroundColor = SETTINGS_BACKGROUND_COLOR
  textField.placeholderColor = SETTINGS_PLACEHOLDER_COLOR

  if (!isAndroid) {
    return
  }

  const nativeTextField = (textField as TextField & { nativeView?: android.widget.EditText }).nativeView
  if (!nativeTextField) {
    return
  }

  nativeTextField.setTextColor(android.graphics.Color.rgb(34, 34, 34))
  nativeTextField.setHintTextColor(android.graphics.Color.rgb(102, 102, 102))
}

function focusSystemNameField(page: Page): void {
  setTimeout(() => {
    const textField = page.getViewById<TextField>('settingsTextField')
    if (textField) {
      applySettingsTextFieldContrast(textField)
    }
    textField?.focus()
  }, 0)
}

export function loaded(args: EventData) {
  const page = args.object as Page
  cleanupPage(page)
  dashboardController.refreshEvenAppStatus()

  const model = page.bindingContext as MainViewModel | null
  const scrollView = page.getViewById<ScrollView>('logScrollView')
  const settingsTextField = page.getViewById<TextField>('settingsTextField')
  if (settingsTextField) {
    applySettingsTextFieldContrast(settingsTextField)
  }
  if (!model || !scrollView) {
    return
  }

  const state: MainPageState = {
    isPinnedToBottom: true,
    scrollHandler: () => {
      state.isPinnedToBottom = isAtBottom(scrollView)
    },
    propertyChangeHandler: (propertyArgs) => {
      if (propertyArgs.propertyName === 'showLog') {
        if (model.showLog) {
          state.isPinnedToBottom = true
          scrollToBottom(scrollView)
        }
        return
      }
      if (propertyArgs.propertyName === 'activeTextSettingEditorKind') {
        if (model.isTextSettingEditorActive) {
          focusSystemNameField(page)
        }
        return
      }
      if (propertyArgs.propertyName !== 'log') {
        return
      }
      if (state.isPinnedToBottom) {
        scrollToBottom(scrollView)
      }
    },
  }

  scrollView.on(ScrollView.scrollEvent, state.scrollHandler)
  model.on(Observable.propertyChangeEvent, state.propertyChangeHandler)
  setPageState(page, state)
  scrollToBottom(scrollView)
  if (model.isTextSettingEditorActive) {
    focusSystemNameField(page)
  }
}

export function unloaded(args: EventData) {
  cleanupPage(args.object as Page)
}
