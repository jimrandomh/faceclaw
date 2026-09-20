/** Local input API v1. Transport: one UTF-8 JSON line per TCP connection. */
export const REMOTE_PORT = 8791;
export const PERMISSIONS = ['input', 'text', 'assistant'] as const;
export type Permission = typeof PERMISSIONS[number];
export const GESTURES = ['click', 'double-click', 'long-press', 'short-then-long-press',
  'scroll-up', 'scroll-down', 'swipe-up', 'swipe-down', 'swipe-left', 'swipe-right'] as const;
export type RemoteGesture = typeof GESTURES[number];
export type TokenRecord = { id: string; name: string; hash: string; permissions: Permission[]; createdAt: number };
export type RemoteHost = {
  ready(): boolean;
  locked(): boolean;
  input(gesture: RemoteGesture, source: 'watch' | 'ring'): Promise<void>;
  acceptsText(): boolean;
  text(text: string, submit: boolean): void;
  assistantAvailable(): boolean;
  assistant(text: string): void;
};
export type Reply = { ok: true } | { ok: false; error: string; message: string };
const error = (code: string, message: string): Reply => ({ ok: false, error: code, message });

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
  if (request.version !== 1 || (request.action !== 'ping' && !PERMISSIONS.includes(request.action))) return error('bad_request', 'Expected version 1 and action ping, input, text or assistant.');
  if (request.action === 'ping') {
    if (request.permission !== undefined && !PERMISSIONS.includes(request.permission)) return error('bad_request', 'Invalid permission.');
    if (request.permission && !token.permissions.includes(request.permission)) return error('forbidden', `Token lacks ${request.permission} permission.`);
    return { ok: true };
  }
  if (request.action === 'text' && request.submit !== undefined && typeof request.submit !== 'boolean') return error('bad_request', 'submit must be a boolean.');
  if (!token.permissions.includes(request.action)) return error('forbidden', `Token lacks ${request.action} permission.`);
  if (request.action === 'input') {
    if (!GESTURES.includes(request.gesture) || !['watch', 'ring'].includes(request.source ?? 'watch') ||
      (request.source === 'ring' && request.gesture.startsWith('swipe-'))) {
      return error('bad_request', 'Invalid gesture or source; directions require watch input.');
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
