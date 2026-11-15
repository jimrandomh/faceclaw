export const ENDPOINT = 'http://127.0.0.1:8791/v1/request';
export const TOKEN_KEY = 'faceclawInputToken';
export const COMMANDS = ['sidebar', 'wake', 'sleep', 'lock', 'unlock', 'connect', 'disconnect', 'close-assistant'];
export const GESTURES = ['click', 'double-click', 'long-press', 'short-then-long-press', 'scroll-up', 'scroll-down', 'swipe-up', 'swipe-down', 'swipe-left', 'swipe-right'];

export function cleanToken(value) {
  const token = typeof value === 'string' ? value.trim().replace(/^"|"$/g, '').trim() : '';
  return /^fc1_[a-f0-9]{64}$/.test(token) ? token : '';
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function userError(message) {
  const error = new Error(message); error.userVisible = true; return error;
}

const UNKNOWN_RESULT = 'Result unknown. Check the glasses before trying again.';
const REJECTED_ERRORS = ['unauthorized', 'forbidden', 'unavailable', 'bad_request', 'locked'];

export function requestBody(operation, token) {
  if (!cleanToken(token)) throw userError('Add your input token in Zepp → Faceclaw Remote settings.');
  const body = { version: 1, token: cleanToken(token) };
  if (!operation || typeof operation !== 'object') throw userError('Invalid watch request.');
  if (operation.kind === 'state') return { ...body, action: 'watch-state' };
  if (operation.kind === 'gesture' && GESTURES.indexOf(operation.gesture) >= 0) {
    return { ...body, action: 'input', gesture: operation.gesture, source: 'watch' };
  }
  if (operation.kind === 'command') {
    const command = operation.command;
    if (command === 'launch-app' && identifier(operation.appId)) return { ...body, action: 'watch-command', command, appId: operation.appId };
    if ((command === 'close-window' || command === 'focus-window') && identifier(operation.windowId)) return { ...body, action: 'watch-command', command, windowId: operation.windowId };
    if (COMMANDS.indexOf(command) >= 0) return { ...body, action: 'watch-command', command };
  }
  throw userError('Unsupported watch command.');
}

const title = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80) : '';
const percentage = value => Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;

export function normalizeState(value) {
  if (!value || value.protocol !== 1 || typeof value.connected !== 'boolean' || !Array.isArray(value.apps) || !Array.isArray(value.windows)) {
    throw userError('Update Faceclaw on the phone. Its watch reply is not compatible.');
  }
  const seenApps = {}, seenWindows = {};
  const apps = value.apps.filter(item => {
    if (!item || !identifier(item.appId) || seenApps['id:' + item.appId]) return false;
    seenApps['id:' + item.appId] = true; return true;
  }).slice(0, 150).map(item => ({ appId: item.appId, title: title(item.title) || item.appId }));
  const windows = value.windows.filter(item => {
    if (!item || !identifier(item.windowId) || seenWindows['id:' + item.windowId]) return false;
    seenWindows['id:' + item.windowId] = true; return true;
  }).slice(0, 100).map(item => ({
    windowId: item.windowId, appId: title(item.appId), title: item.appId === 'launcher' ? 'Launcher' : title(item.title) || 'Window',
    focused: item.focused === true, closeable: item.closeable === true,
  }));
  return {
    protocol: 1, version: title(value.version), phase: title(value.phase), status: title(value.status),
    connected: value.connected, preview: value.preview === true, screenOn: value.screenOn === true,
    locked: value.locked === true, charging: value.charging === true, silentMode: value.silentMode === true,
    listening: value.listening === true, canUnlock: value.canUnlock === true,
    remoteEnabled: value.remoteEnabled === true, crownClockwiseNext: value.crownClockwiseNext === true,
    battery: percentage(value.battery), caseBattery: percentage(value.caseBattery),
    foreground: value.foreground ? { appId: title(value.foreground.appId), title: value.foreground.appId === 'launcher' ? 'Launcher' : title(value.foreground.title) } : null,
    apps, windows,
  };
}

// Uses Zepp's fetch({url,...}) API. Each operation has exactly one POST: an
// unanswered launch/input may have executed and must never be replayed.
export async function phoneRequest(fetcher, operation, token, options = {}) {
  const body = requestBody(operation, token);
  const isState = operation.kind === 'state';
  const start = options.setTimeout || setTimeout, stop = options.clearTimeout || clearTimeout;
  let timer;
  try {
    const response = await Promise.race([
      fetcher({ url: ENDPOINT, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      new Promise((_, reject) => { timer = start(() => reject(userError(isState
        ? 'No phone reply. Open Faceclaw and check Zepp.'
        : UNKNOWN_RESULT)), options.timeout || 8000); }),
    ]);
    if (response.status === 504) throw userError(isState
      ? 'No phone reply. Open Faceclaw and check Zepp.'
      : UNKNOWN_RESULT);
    let result;
    try { result = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; }
    catch (_) { throw userError(isState ? 'Unexpected phone reply. Update Faceclaw.' : UNKNOWN_RESULT); }
    if (!isState) {
      // A damaged reply or server exception may follow an executed command.
      // Only a valid success or an explicit, recognized rejection resolves it.
      const objectReply = result && typeof result === 'object' && !Array.isArray(result);
      const validStatus = response.status === undefined || Number.isInteger(response.status) && response.status >= 200 && response.status < 600;
      const successStatus = response.status === undefined || validStatus && response.status < 300;
      const accepted = objectReply && successStatus && result.ok === true && (result.error === undefined || result.error === null);
      const rejected = objectReply && validStatus && result.ok === false && REJECTED_ERRORS.indexOf(result.error) >= 0;
      const httpRejected = objectReply && [401, 403, 404].indexOf(response.status) >= 0 &&
        (result.ok === undefined || result.ok === false) && result.error !== 'failed' && result.error !== 'timeout';
      if (!accepted && !rejected && !httpRejected) throw userError(UNKNOWN_RESULT);
    }
    if (response.status === 401 || response.status === 403) throw userError('Check the input token and its Provide input permission.');
    if (!result || result.ok !== true) {
      if (result && result.error === 'unauthorized') throw userError('Input token expired or revoked. Copy a new token from Faceclaw into Zepp settings.');
      if (result && result.error === 'forbidden' && /token/i.test(result.message || '')) throw userError('The input token needs Provide input permission in Faceclaw.');
      if (result && typeof result.message === 'string') throw userError(result.message.slice(0, 160));
      if (response.status === 404) throw userError('Update Faceclaw to the Zepp-enabled build.');
      throw userError('Faceclaw refused the command. Check the phone.');
    }
    if (response.status && (response.status < 200 || response.status >= 300)) throw userError('Faceclaw request failed. Check the phone.');
    return isState ? { ok: true, state: normalizeState(result.state) } : { ok: true, message: title(result.message) || 'Sent to Faceclaw' };
  } catch (error) {
    // Never include transport internals (which may contain the token/body).
    if (error && error.userVisible === true) throw error;
    throw userError(isState ? 'Open Faceclaw on the phone. Check Zepp is connected.' : 'No reply. Result unknown; check the glasses.');
  } finally { if (timer !== undefined) stop(timer); }
}
