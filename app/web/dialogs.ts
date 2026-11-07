/** Promise-based dialogs on a <dialog> element, for NativeScript's Dialogs and the settings editors. */
type DialogButton<T> = { label: string; value: T; primary?: boolean };

function openDialog<T>(options: {
  title?: string;
  message?: string;
  input?: { value: string; type: string };
  buttons: DialogButton<T>[];
  cancelValue: T;
}, read?: (value: T, input: HTMLInputElement | null) => T): Promise<T> {
  if (typeof document === "undefined") return Promise.resolve(options.cancelValue);
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "fc-dialog";
    if (options.title) {
      const title = document.createElement("h2");
      title.textContent = options.title;
      dialog.append(title);
    }
    if (options.message) {
      const message = document.createElement("p");
      message.textContent = options.message;
      dialog.append(message);
    }
    let input: HTMLInputElement | null = null;
    if (options.input) {
      input = document.createElement("input");
      input.type = options.input.type;
      input.value = options.input.value;
      dialog.append(input);
    }
    const row = document.createElement("div");
    row.className = "fc-dialog-buttons";
    const finish = (value: T) => {
      dialog.close();
      dialog.remove();
      resolve(read ? read(value, input) : value);
    };
    for (const button of options.buttons) {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = button.label;
      if (button.primary) element.className = "primary";
      element.addEventListener("click", () => finish(button.value));
      row.append(element);
    }
    dialog.append(row);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(options.cancelValue); });
    input?.addEventListener("keydown", (event) => {
      event.stopPropagation();
      const primary = options.buttons.find((button) => button.primary);
      if (event.key === "Enter" && primary) { event.preventDefault(); finish(primary.value); }
    });
    document.body.append(dialog);
    dialog.showModal();
    input?.select();
  });
}

export async function alertDialog(options: { title?: string; message?: string; okButtonText?: string }): Promise<void> {
  await openDialog({ ...options, cancelValue: undefined, buttons: [{ label: options.okButtonText ?? "OK", value: undefined, primary: true }] });
}

export function confirmDialog(options: { title?: string; message?: string; okButtonText?: string; cancelButtonText?: string }): Promise<boolean> {
  return openDialog<boolean>({ ...options, cancelValue: false, buttons: [
    { label: options.cancelButtonText ?? "Cancel", value: false },
    { label: options.okButtonText ?? "OK", value: true, primary: true },
  ] });
}

export function promptDialog(options: { title?: string; message?: string; defaultText?: string; inputType?: string; okButtonText?: string; cancelButtonText?: string }): Promise<{ result: boolean; text: string }> {
  const secret = options.inputType === "password";
  return openDialog<{ result: boolean; text: string }>({
    title: options.title, message: options.message,
    input: { value: options.defaultText ?? "", type: secret ? "password" : "text" },
    cancelValue: { result: false, text: "" },
    buttons: [
      { label: options.cancelButtonText ?? "Cancel", value: { result: false, text: "" } },
      { label: options.okButtonText ?? "OK", value: { result: true, text: "" }, primary: true },
    ],
  }, (value, input) => (value.result ? { result: true, text: input?.value ?? "" } : value));
}

export function actionDialog(options: { title?: string; message?: string; cancelButtonText?: string; actions?: string[] }): Promise<string> {
  const cancel = options.cancelButtonText ?? "Cancel";
  return openDialog<string>({ title: options.title, message: options.message, cancelValue: cancel, buttons: [
    ...(options.actions ?? []).map((action) => ({ label: action, value: action })),
    { label: cancel, value: cancel },
  ] });
}
