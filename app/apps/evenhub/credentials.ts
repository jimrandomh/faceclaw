import {
  ConfigSettingBoolean,
  ConfigSettingString,
} from "../../ui/dashboard-settings";
import { getStringSetting, setStringSetting } from "../../native/settings-store";

/**
 * Persistent EvenHub session data. Passwords are deliberately excluded: the
 * password entered in the login form lives only in memory until the request
 * completes, while a successful login may persist the returned token.
 */
export const evenHubEmailSetting = new ConfigSettingString({
  id: "evenhub-saved-email",
  label: "Email",
  storageKey: "integrations.evenhub.email",
  defaultValue: "",
  normalize: normalizeEmail,
});

export const evenHubTokenSetting = new ConfigSettingString({
  id: "evenhub-token",
  label: "Login token",
  storageKey: "integrations.evenhub.token",
  defaultValue: "",
  inputKind: "password",
  normalize: normalizeToken,
  formatValue: (value) => (value ? "(signed in)" : "(signed out)"),
});

class TransientStringSetting extends ConfigSettingString {
  private value: string;
  private readonly normalizeValue: (value: string | null | undefined) => string;

  constructor(options: ConstructorParameters<typeof ConfigSettingString>[0]) {
    super(options);
    this.normalizeValue = options.normalize ?? ((value) => value ?? "");
    this.value = this.normalizeValue(options.defaultValue);
  }

  override get(): string {
    return this.value;
  }

  override set(value: string): string {
    this.value = this.normalizeValue(value);
    return this.value;
  }
}

class TransientBooleanSetting extends ConfigSettingBoolean {
  private value: boolean;

  constructor(options: ConstructorParameters<typeof ConfigSettingBoolean>[0]) {
    super(options);
    this.value = options.defaultValue;
  }

  override get(): boolean {
    return this.value;
  }

  override set(value: boolean): boolean {
    this.value = value;
    return value;
  }
}

/** Phone login-form values. These overrides never touch the settings store. */
export const evenHubLoginEmailSetting = new TransientStringSetting({
  id: "evenhub-login-email",
  label: "Email",
  storageKey: "transient.evenhub.email",
  defaultValue: "",
  editorTitle: "Email",
  glassesEditTitle: "Edit Even email",
  inputKind: "email",
  normalize: normalizeEmail,
});

export const evenHubLoginPasswordSetting = new TransientStringSetting({
  id: "evenhub-login-password",
  label: "Password",
  storageKey: "transient.evenhub.password",
  defaultValue: "",
  editorTitle: "Password",
  glassesEditTitle: "Edit Even password",
  inputKind: "password",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, ""),
  formatValue: (value) => (value ? "(set)" : "(not set)"),
});

export const evenHubRememberMeSetting = new TransientBooleanSetting({
  id: "evenhub-remember-me",
  label: "Remember me",
  storageKey: "transient.evenhub.rememberMe",
  defaultValue: true,
});

let transientToken = "";

export function getEvenHubToken(): string {
  return transientToken || evenHubTokenSetting.get();
}

export function hasEvenHubCredentials(): boolean {
  return Boolean(getEvenHubToken());
}

export function saveEvenHubSession(email: string, token: string, remember: boolean): void {
  const normalizedEmail = normalizeEmail(email);
  const normalizedToken = normalizeToken(token);
  if (remember) {
    evenHubEmailSetting.set(normalizedEmail);
    evenHubTokenSetting.set(normalizedToken);
    transientToken = "";
  } else {
    evenHubEmailSetting.set("");
    evenHubTokenSetting.set("");
    transientToken = normalizedToken;
  }
}

/** Clear a rejected token but retain a remembered email for the next login. */
export function invalidateEvenHubToken(): void {
  transientToken = "";
  evenHubTokenSetting.set("");
}

export function clearEvenHubSession(): void {
  transientToken = "";
  evenHubEmailSetting.set("");
  evenHubTokenSetting.set("");
  clearEvenHubLoginForm();
}

export function resetEvenHubLoginForm(): void {
  evenHubLoginEmailSetting.set(evenHubEmailSetting.get());
  evenHubLoginPasswordSetting.set("");
  evenHubRememberMeSetting.set(true);
}

export function clearEvenHubLoginForm(): void {
  evenHubLoginEmailSetting.set("");
  evenHubLoginPasswordSetting.set("");
  evenHubRememberMeSetting.set(true);
}

/** Discard a window-scoped session; remembered sessions are left intact. */
export function clearTransientEvenHubSession(): void {
  if (transientToken) transientToken = "";
  clearEvenHubLoginForm();
}

function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").replace(/[\x00-\x1f]+/g, "").trim();
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").replace(/[\x00-\x20\x7f]+/g, "").trim();
}

// One-time security migration from builds that persisted the account password.
// Existing users must sign in once more so the password can be exchanged for a
// token under the new storage model.
const LEGACY_PASSWORD_KEY = "integrations.evenhub.password";
if (getStringSetting(LEGACY_PASSWORD_KEY, "")) {
  setStringSetting(LEGACY_PASSWORD_KEY, "");
}
