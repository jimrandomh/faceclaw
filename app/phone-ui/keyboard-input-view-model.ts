import { Dialogs, Observable, type EventData, type TextView, type View } from '@nativescript/core'
import type { KeyboardInputSession, KeyboardInputVisibility } from '../ui/shell/keyboard-input'

/** The visibility button's cycle: both → phone only → glasses only → both. */
const NEXT_VISIBILITY: Record<KeyboardInputVisibility, KeyboardInputVisibility> = { both: 'phone', phone: 'glasses', glasses: 'both' }
const VISIBILITY_DESCRIPTIONS: Record<KeyboardInputVisibility, string> = {
  both: 'Shown on phone and glasses', phone: 'Shown on phone only', glasses: 'Shown on glasses only',
}
/**
 * Phone button text for the glasses' send-target labels, short enough for
 * every button to share one strip. Unlisted labels (the assistant overlay's
 * "Send") are already short.
 */
const SHORT_TARGET_LABELS: Record<string, string> = { 'Send to Assistant': 'To Assistant', 'Type Into App': 'To App' }
const HISTORY_LABEL_LENGTH = 80
const DIMMED_ICON_OPACITY = 0.3

/** One history entry as a single line, truncated for the picker. */
function historyLabel(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > HISTORY_LABEL_LENGTH ? `${line.slice(0, HISTORY_LABEL_LENGTH - 1)}…` : line
}

/**
 * Phone editor for the shell's keyboard session: the binding context of the
 * shared keyboard-input-panel.xml on both platforms (Android's MainViewModel
 * hands it the session from the dashboard controller, iOS's main page from
 * the preview controller).
 */
export class KeyboardInputViewModel extends Observable {
  private session: KeyboardInputSession | null = null
  private text = ''

  setSession(session: KeyboardInputSession | null): void {
    if (session === this.session) return
    this.session = session
    this.text = ''
    this.notifyPanel(['keyboardInputText', 'keyboardInputVisibility', 'keyboardInputPrimaryTargetLabel',
      'keyboardInputPrimaryTargetVisibility', 'keyboardInputSecondaryTargetLabel', 'keyboardInputSecondaryTargetVisibility',
      'keyboardInputHistoryOpacity'])
    this.notifyVisibilityMode()
  }
  private notifyPanel(properties: string[]): void {
    for (const property of properties) this.notifyPropertyChange(property, this.get(property))
  }
  private notifyVisibilityMode(): void {
    this.notifyPanel(['keyboardInputPhoneIconOpacity', 'keyboardInputGlassesIconOpacity', 'keyboardInputVisibilityDescription',
      'keyboardInputFieldClass', 'keyboardInputGlassesOnlyVisibility'])
  }
  get keyboardInputVisibility(): 'visible' | 'collapse' { return this.session ? 'visible' : 'collapse' }
  get keyboardInputText(): string { return this.text }
  set keyboardInputText(text: string) { this.text = text; this.session?.setText(text) }
  private targetLabel(index: number): string {
    const label = this.session?.targets[index]?.label ?? ''
    return SHORT_TARGET_LABELS[label] ?? label
  }
  get keyboardInputPrimaryTargetLabel(): string { return this.targetLabel(0) }
  get keyboardInputSecondaryTargetLabel(): string { return this.targetLabel(1) }
  get keyboardInputPrimaryTargetVisibility(): 'visible' | 'collapse' { return this.session?.targets[0] ? 'visible' : 'collapse' }
  get keyboardInputSecondaryTargetVisibility(): 'visible' | 'collapse' { return this.session?.targets[1] ? 'visible' : 'collapse' }
  onKeyboardInputTextChange(args: { value?: string; object?: { text?: string } }): void {
    this.keyboardInputText = args.object?.text ?? args.value ?? ''
  }
  onKeyboardInputPrimarySendTap(): void { this.send(0) }
  onKeyboardInputSecondarySendTap(): void { this.send(1) }
  private send(index: number): void {
    const target = this.session?.targets[index]
    if (!target) return
    this.session.setText(this.text)
    this.session.sendTo(target.id)
  }
  onKeyboardInputDiscardTap(): void { this.session?.discard() }

  // ---- visibility button: where the dialog shows ----
  //
  // Glasses-only keeps the text field focused (so the IME keeps typing into
  // it) but shrinks it to an invisible sliver; a hint line stands in for it
  // and refocuses it if the IME was dismissed.

  private get visibilityMode(): KeyboardInputVisibility { return this.session?.visibility ?? 'both' }
  get keyboardInputPhoneIconOpacity(): number { return this.visibilityMode === 'glasses' ? DIMMED_ICON_OPACITY : 1 }
  get keyboardInputGlassesIconOpacity(): number { return this.visibilityMode === 'phone' ? DIMMED_ICON_OPACITY : 1 }
  get keyboardInputVisibilityDescription(): string { return VISIBILITY_DESCRIPTIONS[this.visibilityMode] }
  get keyboardInputFieldClass(): string { return this.visibilityMode === 'glasses' ? 'keyboard-input-field-hidden' : '' }
  get keyboardInputGlassesOnlyVisibility(): 'visible' | 'collapse' { return this.visibilityMode === 'glasses' ? 'visible' : 'collapse' }
  onKeyboardInputVisibilityTap(): void {
    if (!this.session) return
    this.session.setVisibility(NEXT_VISIBILITY[this.visibilityMode])
    this.notifyVisibilityMode()
  }
  onKeyboardInputGlassesOnlyHintTap(args: EventData): void {
    focusField(args.object as View)
  }

  // ---- history button: recent sent messages (in memory, newest first) ----

  get keyboardInputHistoryOpacity(): number { return this.session?.history.length ? 1 : DIMMED_ICON_OPACITY }
  async onKeyboardInputHistoryTap(args: EventData): Promise<void> {
    const session = this.session
    if (!session?.history.length) return
    const entries = new Map<string, string>()
    for (const entry of session.history) {
      const label = historyLabel(entry)
      if (!entries.has(label)) entries.set(label, entry)
    }
    const choice = await Dialogs.action({ title: 'Recent inputs', cancelButtonText: 'Cancel', actions: [...entries.keys()] })
    const text = entries.get(choice)
    if (text === undefined || session !== this.session) return
    const field = fieldNear(args.object as View)
    this.keyboardInputText = text
    // Through the view, not a property change: its textChange handler then
    // syncs the model and session the same way typing does.
    if (field) field.text = text
    focusField(args.object as View, text.length)
  }
}

function fieldNear(view: View): TextView | undefined {
  return view.page?.getViewById<TextView>('keyboardInputField')
}

/** Focus the panel's field (bringing the IME back), optionally placing the caret. */
function focusField(view: View, caret?: number): void {
  setTimeout(() => {
    const field = fieldNear(view)
    if (!field) return
    field.focus()
    if (caret !== undefined) field.setSelection(caret)
  }, 0)
}
