'use strict';
const { Input } = require('enquirer');

// Enquirer owns the editable line and its rendering. The remote's single
// keypress listener routes keys here so starting/closing a prompt cannot leak
// an Enter, arrow or Esc into the watch controls, even within one input chunk.
class MessageInput extends Input {
  start() {} // Keep terminal ownership (raw mode and signals) with the remote.
  cursorHide() {
    if (this.cursorHidden) return;
    this.cursorHidden = true;
    this.stdout.write('\x1b[?25l');
    const show = () => this.cursorShow();
    // Enquirer's default cursor cleanup installs signal handlers that call
    // process.exit immediately. Let the remote restore raw mode first instead.
    process.once('exit', show);
    this.once('close', () => { show(); process.removeListener('exit', show); });
  }
  render() {
    this.paint = (this.paint || Promise.resolve()).then(() => super.render());
    return this.paint;
  }
  home() { return this.first(); }
  end() { return this.last(); }
  last() { this.cursor = this.input.length; return this.render(); }
  async cancel() {
    this.input = this.value = '';
    this.cursor = 0;
    this.state.clipboard = [];
    return super.cancel();
  }
}

function createEditor(action, input, output) {
  const prompt = new MessageInput({
    name: action, message: action === 'text' ? 'Foreground text' : 'Assistant message',
    footer: 'Enter: send | Esc: discard | Ctrl-C: quit',
    stdin: input, stdout: output, initial: '',
    validate: value => value.length > 8000 ? 'Maximum 8000 characters.' : value.includes('\0') ? 'NUL is not allowed.' : true,
  });
  let resolve, reject, closing = false;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  prompt.once('submit', text => {
    resolve(text);
    prompt.input = prompt.value = '';
    prompt.state.clipboard = [];
  });
  prompt.once('cancel', () => resolve(null));
  // Queue keys during async initialization, including typing/paste that arrives
  // in the same terminal chunk as the mode-switching 'i' or 'a'.
  let keys = prompt.initialize().catch(reject);
  return {
    result,
    keypress(text, key) {
      keys = keys.then(async () => {
        if (closing || prompt.state.closed) return;
        await prompt.keypress(text, key);
        await prompt.paint;
      }).catch(reject);
    },
    cancel() {
      closing = true;
      return keys.then(() => prompt.state.closed ? undefined : prompt.cancel()).catch(reject);
    },
  };
}
module.exports = { createEditor };
