/** Local input API v1. Transport: a JSON line over TCP, or HTTP POST /v1/request. */
export const REMOTE_PORT = 8791;
export const PERMISSIONS = ['input', 'text', 'assistant'] as const;
export type Permission = typeof PERMISSIONS[number];
export const GESTURES = ['click', 'double-click', 'long-press', 'short-then-long-press',
  'scroll-up', 'scroll-down', 'swipe-up', 'swipe-down', 'swipe-left', 'swipe-right'] as const;
export type RemoteGesture = typeof GESTURES[number];
export type TokenRecord = { id: string; name: string; hash: string; permissions: Permission[]; createdAt: number };
export const WATCH_COMMANDS = ['launch-app', 'focus-window', 'close-window', 'sidebar', 'wake', 'sleep',
  'lock', 'unlock', 'connect', 'disconnect', 'close-assistant'] as const;
export type WatchCommandRequest = { command: typeof WATCH_COMMANDS[number]; appId?: string; windowId?: string };
export type WatchCommandReply = { ok: boolean; message: string };
export type RemoteHost = {
  ready(): boolean;
  locked(): boolean;
  input(gesture: RemoteGesture, source: 'watch' | 'ring'): Promise<void>;
  acceptsText(): boolean;
  text(text: string, submit: boolean): void;
  assistantAvailable(): boolean;
  assistant(text: string): void;
  /** Available before glasses connect, so the watch can show status and request connection. */
  watchState?(): Record<string, unknown> | undefined;
  watchCommand?(request: WatchCommandRequest): Promise<WatchCommandReply>;
  watchControlEnabled?(): boolean;
  /** Null means navigation cannot safely act on the current glasses display. */
  navigationContext?(): string | null;
};
export type NavigationState = { version: 1; context: string | null };
export type Reply = { ok: true; state?: Record<string, unknown>; message?: string; navigation?: NavigationState } | { ok: false; error: string; message: string };
const error = (code: string, message: string): Reply => ({ ok: false, error: code, message });
const NAVIGATION_GESTURES: readonly RemoteGesture[] = ['scroll-up', 'scroll-down', 'swipe-up', 'swipe-down', 'swipe-left', 'swipe-right'];
const NAVIGATION_MAX_FUTURE_MS = 2000;
const NAVIGATION_MAX_RECORDS = 128;
type NavigationRecord = { pending: boolean; until: number };
// Shared by all listeners using this token store. Never evict a live record to
// make room: doing so could let a delayed duplicate execute a second time.
const navigationRecords = new WeakMap<TokenStore, Map<string, NavigationRecord>>();

function validNavigationContext(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

function navigationState(host: RemoteHost): NavigationState {
  const context = host.navigationContext?.();
  return { version: 1, context: validNavigationContext(context) ? context : null };
}

async function handleWatchNavigation(request: Record<string, unknown>, token: TokenRecord, tokens: TokenStore, host: RemoteHost): Promise<Reply> {
  if (!token.permissions.includes('input')) return error('forbidden', 'Token lacks input permission.');
  const { requestId, expiresAt, context, gesture } = request;
  if (typeof requestId !== 'string' || requestId.length >= 96 || !/^fc-[a-z0-9-]+$/.test(requestId) ||
      typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || !validNavigationContext(context) ||
      typeof gesture !== 'string' || !NAVIGATION_GESTURES.includes(gesture as RemoteGesture) ||
      (request.source !== undefined && request.source !== 'watch')) {
    return error('bad_request', 'Invalid watch navigation request.');
  }
  const now = Date.now();
  let records = navigationRecords.get(tokens);
  if (!records) { records = new Map(); navigationRecords.set(tokens, records); }
  for (const [key, record] of records) if (!record.pending && record.until <= now) records.delete(key);
  const key = `${token.hash}:${requestId}`;
  // A duplicate may refer to an input still running, or to one whose reply was
  // lost. It is not evidence that the original input failed or was not sent.
  if (records.has(key)) return error('duplicate', 'Navigation was already received; its original result may be unknown.');
  if (expiresAt <= now) return error('expired', 'Navigation expired before it was sent to the glasses.');
  if (expiresAt > now + NAVIGATION_MAX_FUTURE_MS) return error('bad_request', 'Navigation expiry is too far in the future.');
  if (records.size >= NAVIGATION_MAX_RECORDS) return error('busy', 'Navigation is busy. This input was not sent.');
  if (!host.navigationContext) return error('unavailable', 'Watch navigation is unavailable in this build.');
  if (host.watchControlEnabled?.() !== true) return error('forbidden', "Watch control is turned off in Faceclaw's Settings > Watch.");
  if (!host.ready()) return error('unavailable', 'Faceclaw is not ready for input.');
  if (host.locked()) return error('locked', 'The glasses are locked.');
  if (navigationState(host).context !== context) return error('context_changed', 'The glasses target changed. This input was not sent.');
  // There is no await between this last expiry/context check, reserving the ID,
  // and dispatch. A request delayed in the native socket backlog cannot revive.
  if (Date.now() >= expiresAt) return error('expired', 'Navigation expired before it was sent to the glasses.');
  const record = { pending: true, until: Math.max(expiresAt, now + NAVIGATION_MAX_FUTURE_MS) };
  records.set(key, record);
  try {
    await host.input(gesture as RemoteGesture, 'watch');
    return { ok: true, navigation: navigationState(host) };
  } catch {
    return error('failed', 'Faceclaw could not complete navigation. Its result may be unknown.');
  } finally {
    record.pending = false;
    record.until = Math.max(record.until, Date.now() + NAVIGATION_MAX_FUTURE_MS);
  }
}

export class TokenStore {
  constructor(private readonly read: () => string, private readonly write: (json: string) => void,
    private readonly random: () => string, private readonly hash: (value: string) => string) {}
  list(): TokenRecord[] {
    try {
      const parsed = JSON.parse(this.read());
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r): r is TokenRecord => r && typeof r.id === 'string' &&
        typeof r.name === 'string' && /^[a-f0-9]{64}$/.test(r.hash) && typeof r.createdAt === 'number' &&
        Array.isArray(r.permissions) && r.permissions.every((p: Permission) => PERMISSIONS.includes(p)));
    } catch { return []; }
  }
  create(name: string, permissions: Permission[]): { token: string; record: TokenRecord } {
    if (!name.trim() || name.length > 80) throw new Error('Enter a token name (1–80 characters).');
    if (!permissions.length || !permissions.every(p => PERMISSIONS.includes(p))) throw new Error('Select at least one permission.');
    const records = this.list();
    if (records.length >= 32) throw new Error('Revoke a token before creating more (maximum 32).');
    const secret = this.random();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Secure random token generation failed.');
    const token = `fc1_${secret}`;
    const hash = this.hash(token);
    const record = { id: hash.slice(0, 16), name: name.trim(), hash, permissions: [...new Set(permissions)], createdAt: Date.now() };
    this.write(JSON.stringify([...records, record]));
    return { token, record };
  }
  permissions(id: string, permissions: Permission[]): void {
    if (!permissions.every(p => PERMISSIONS.includes(p))) throw new Error('Invalid permission.');
    this.write(JSON.stringify(this.list().map(r => r.id === id ? { ...r, permissions: [...new Set(permissions)] } : r)));
  }
  revoke(id: string): void { this.write(JSON.stringify(this.list().filter(r => r.id !== id))); }
  authenticate(token: unknown): TokenRecord | undefined {
    if (typeof token !== 'string' || !/^fc1_[a-f0-9]{64}$/.test(token)) return undefined;
    const digest = this.hash(token);
    // Compare fixed-size digests without an early exit on mismatching bytes.
    return this.list().find(r => {
      let difference = r.hash.length ^ digest.length;
      for (let i = 0; i < 64; i++) difference |= r.hash.charCodeAt(i) ^ digest.charCodeAt(i);
      return difference === 0;
    });
  }
}

export async function handleRequest(body: string, tokens: TokenStore, host: RemoteHost): Promise<Reply> {
  let request: any;
  try { request = JSON.parse(body); } catch { return error('bad_request', 'Expected a JSON object.'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return error('bad_request', 'Expected a JSON object.');
  const token = tokens.authenticate(request.token);
  if (!token) return error('unauthorized', 'Invalid or revoked token.');
  const watchRequest = request.action === 'watch-state' || request.action === 'watch-command' || request.action === 'watch-navigation';
  if (request.version !== 1 || (request.action !== 'ping' && !watchRequest && !PERMISSIONS.includes(request.action))) return error('bad_request', 'Expected version 1 and a supported action.');
  if (request.action === 'ping') {
    if (request.permission !== undefined && !PERMISSIONS.includes(request.permission)) return error('bad_request', 'Invalid permission.');
    if (request.permission && !token.permissions.includes(request.permission)) return error('forbidden', `Token lacks ${request.permission} permission.`);
    return { ok: true };
  }
  // Listing and managing apps has the same reach as ring/watch navigation.
  // Authenticate every request, including reads; token revocation remains immediate.
  if (watchRequest) {
    if (!token.permissions.includes('input')) return error('forbidden', 'Token lacks input permission.');
    try {
      if (request.action === 'watch-navigation') return await handleWatchNavigation(request, token, tokens, host);
      if (request.action === 'watch-state') {
        const state = host.watchState?.();
        return state ? { ok: true, state, ...(host.navigationContext ? { navigation: navigationState(host) } : {}) } : error('unavailable', 'Open Faceclaw on the phone first.');
      }
      if (!WATCH_COMMANDS.includes(request.command)) return error('bad_request', 'Unknown watch command.');
      const field = request.command === 'launch-app' ? 'appId' :
        ['focus-window', 'close-window'].includes(request.command) ? 'windowId' : null;
      if (field && (typeof request[field] !== 'string' || !request[field].trim() ||
        request[field].length > 512 || /[\x00-\x1f]/.test(request[field]))) return error('bad_request', `Invalid ${field}.`);
      if (!host.watchCommand) return error('unavailable', 'Watch commands are unavailable in this build.');
      // Forward only the command and its validated identifier, never arbitrary payload fields.
      const command: WatchCommandRequest = { command: request.command };
      if (field === 'appId') command.appId = request.appId.trim();
      if (field === 'windowId') command.windowId = request.windowId.trim();
      const result = await host.watchCommand(command);
      return result.ok ? { ok: true, message: result.message } : error('unavailable', result.message);
    } catch { return error('failed', 'Faceclaw could not complete the watch request.'); }
  }
  if (request.action === 'text' && request.submit !== undefined && typeof request.submit !== 'boolean') return error('bad_request', 'submit must be a boolean.');
  if (!token.permissions.includes(request.action)) return error('forbidden', `Token lacks ${request.action} permission.`);
  if (request.action === 'input') {
    if (!GESTURES.includes(request.gesture) || !['watch', 'ring'].includes(request.source ?? 'watch') ||
      (request.source === 'ring' && request.gesture.startsWith('swipe-'))) {
      return error('bad_request', 'Invalid gesture or source; directions require watch input.');
    }
    if ((request.source ?? 'watch') === 'watch' && host.watchControlEnabled?.() === false) {
      return error('forbidden', "Watch control is turned off in Faceclaw's Settings > Watch.");
    }
  } else if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 8000 || request.text.includes('\0')) {
    return error('bad_request', 'Text must contain 1–8000 characters without NUL.');
  }
  if (!host.ready()) return error('unavailable', 'Faceclaw is not ready for input.');
  // Gestures follow the normal lock-screen path. Text must never bypass it.
  if (request.action !== 'input' && host.locked()) return error('locked', 'The glasses are locked.');
  try {
    if (request.action === 'input') await host.input(request.gesture, request.source ?? 'watch');
    else if (request.action === 'text') {
      if (!host.acceptsText()) return error('unavailable', 'The foreground window does not accept text.');
      host.text(request.text, request.submit !== false);
    } else {
      if (!host.assistantAvailable()) return error('unavailable', 'Set up the voice assistant in Settings first.');
      host.assistant(request.text);
    }
    return { ok: true };
  } catch { return error('failed', 'Faceclaw could not deliver the request.'); }
}
