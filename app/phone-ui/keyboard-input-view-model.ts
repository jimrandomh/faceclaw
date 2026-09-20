import { Observable } from '@nativescript/core'
import type { KeyboardInputSession } from '../ui/shell/keyboard-input'

/** Phone editor for the shell's keyboard session, using the shared XML panel. */
export class KeyboardInputViewModel extends Observable {
  private session: KeyboardInputSession | null = null
  private text = ''

  setSession(session: KeyboardInputSession | null): void {
    if (session === this.session) return
    this.session = session
    this.text = ''
    for (const property of ['keyboardInputText', 'keyboardInputVisibility', 'keyboardInputPrimaryTargetLabel',
      'keyboardInputPrimaryTargetVisibility', 'keyboardInputSecondaryTargetLabel', 'keyboardInputSecondaryTargetVisibility']) {
      this.notifyPropertyChange(property, this.get(property))
    }
  }
  get keyboardInputVisibility(): 'visible' | 'collapse' { return this.session ? 'visible' : 'collapse' }
  get keyboardInputText(): string { return this.text }
  set keyboardInputText(text: string) { this.text = text; this.session?.setText(text) }
  private targetLabel(index: number): string {
    const target = this.session?.targets[index]
    return target?.id === 'assistant' ? 'Send to Agent' : target?.id === 'app' ? 'Type into App' : target?.label ?? ''
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
}
