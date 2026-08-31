import { Application, Color, EventData, isAndroid, Observable, Page, TextField } from '@nativescript/core'
import { MainViewModel } from './main-view-model'
import { dashboardController } from '../g2/dashboard-controller'

const SETTINGS_TEXT_COLOR = new Color('#222222')
const SETTINGS_BACKGROUND_COLOR = new Color('#ffffff')
const SETTINGS_PLACEHOLDER_COLOR = new Color('#666666')

export function navigatingTo(args: EventData) {
  const page = <Page>args.object
  page.bindingContext = new MainViewModel()
}

type MainPageState = {
  model: MainViewModel
  propertyChangeHandler: (args: EventData & { propertyName?: string }) => void
  orientationHandler: () => void
}

function getPageState(page: Page): MainPageState | undefined {
  return (page as Page & { __mainPageState?: MainPageState }).__mainPageState
}

function setPageState(page: Page, state?: MainPageState): void {
  ;(page as Page & { __mainPageState?: MainPageState }).__mainPageState = state
}

function cleanupPage(page: Page): void {
  const state = getPageState(page)
  if (!state) {
    setPageState(page, undefined)
    return
  }
  state.model.off(Observable.propertyChangeEvent, state.propertyChangeHandler)
  Application.off(Application.orientationChangedEvent, state.orientationHandler)
  // navigatingTo builds a fresh model each visit; drop the old one's
  // controller/settings subscriptions or every navigation leaks a listener.
  state.model.dispose()
  setPageState(page, undefined)
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
  // Editing an existing value usually means replacing it: select all on focus
  // so typing starts fresh but the current value stays visible.
  nativeTextField.setSelectAllOnFocus(true)
}

/**
 * Leaving keyboard-input mode: the glasses navigated away from the text
 * setting, so the phone's keyboard has nothing to type into any more.
 */
function dismissTextEditorKeyboard(page: Page): void {
  page.getViewById<TextField>('settingsTextField')?.dismissSoftInput()
  page.getViewById<TextField>('secondarySettingsTextField')?.dismissSoftInput()
}

function focusTextEditor(page: Page): void {
  setTimeout(() => {
    const textField = page.getViewById<TextField>('settingsTextField')
    const secondaryTextField = page.getViewById<TextField>('secondarySettingsTextField')
    if (textField) {
      applySettingsTextFieldContrast(textField)
    }
    if (secondaryTextField) {
      applySettingsTextFieldContrast(secondaryTextField)
    }
    textField?.focus()
  }, 0)
}

export function loaded(args: EventData) {
  const page = args.object as Page
  cleanupPage(page)
  dashboardController.refreshEvenAppStatus()

  const model = page.bindingContext as MainViewModel | null
  // Re-subscribe after a suspend/resume cycle (unloaded disposed the model);
  // a no-op on the first load after construction.
  model?.attach()
  // Automatically connect on reaching the main page (no-op if already
  // connected or if no glasses are configured).
  void model?.autoConnect()
  // Reopen the apps that were open before the last restart (no-op after the
  // first load).
  void dashboardController.restoreOpenApps()
  const settingsTextField = page.getViewById<TextField>('settingsTextField')
  model?.refreshLayoutMetrics()
  if (settingsTextField) {
    applySettingsTextFieldContrast(settingsTextField)
  }
  if (!model) {
    return
  }

  const state: MainPageState = {
    model,
    orientationHandler: () => {
      setTimeout(() => {
        model.refreshLayoutMetrics()
      }, 0)
    },
    propertyChangeHandler: (propertyArgs) => {
      if (propertyArgs.propertyName === 'activeTextSettingId') {
        if (model.isTextSettingEditorActive) {
          focusTextEditor(page)
        } else {
          dismissTextEditorKeyboard(page)
        }
      }
    },
  }

  model.on(Observable.propertyChangeEvent, state.propertyChangeHandler)
  Application.on(Application.orientationChangedEvent, state.orientationHandler)
  setPageState(page, state)
  if (model.isTextSettingEditorActive) {
    focusTextEditor(page)
  }
}

export function unloaded(args: EventData) {
  cleanupPage(args.object as Page)
}
