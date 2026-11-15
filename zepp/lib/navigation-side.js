// One HTTP request at a time. Only fresh directions wait here, never in a TCP backlog.
export function createNavigationSide({ send, now = Date.now, start = setTimeout, stop = clearTimeout }) {
  let session = null, sequence = 0, context = null, active = null, queue = [], retired = [];
  const validSession = id => typeof id === 'string' && id.length > 0 && id.length <= 96 && /^[a-zA-Z0-9_-]+$/.test(id);
  const reject = (code, error) => ({ ok: false, notSent: true, code, error });
  const finish = (item, result) => { if (item.done) return; item.done = true; stop(item.timer); item.resolve(result); };
  const flush = (code, error) => { for (const item of queue) finish(item, reject(code, error)); queue = []; };
  function cancel(id) {
    if (!validSession(id)) return;
    if (retired.indexOf(id) < 0) retired.push(id);
    if (retired.length > 32) retired.shift();
    if (session === id) { session = null; context = null; flush('session_changed', 'Navigation canceled · Not sent'); }
  }
  async function drain() {
    if (active) return;
    while (queue.length) {
      const item = queue.shift();
      if (item.done) continue;
      if (item.session !== session || item.context !== context) { finish(item, reject('context_changed', 'Glasses screen changed · Not sent')); continue; }
      if (now() >= item.expiresAt) { finish(item, reject('expired', 'Swipe expired · Not sent')); continue; }
      active = item; stop(item.timer);
      const at = now(); let result;
      try { result = await send(item.operation, item.requestId, { requestId: item.requestId, expiresAt: item.expiresAt, context: item.context }); }
      catch (_) { result = { ok: false, notSent: false, code: 'unknown', error: 'Result unknown. Check the glasses.' }; }
      result = { ...result, timing: { queueMs: Math.max(0, at - item.at), httpMs: Math.max(0, now() - at) } };
      finish(item, result); active = null;
      if (item.session !== session) continue;
      if (!result.ok && !result.notSent) { cancel(item.session); continue; }
      if (result.ok && (!result.navigation || result.navigation.context !== context)) {
        context = result.navigation ? result.navigation.context : null;
        flush('context_changed', 'Glasses screen changed · Not sent');
      } else if (!result.ok && result.code !== 'busy') {
        // Permission, expiry and context rejection end this burst; a fresh state revalidates it.
        cancel(item.session);
      }
    }
  }
  return {
    busy: () => !!active || queue.length > 0,
    register(id, nextContext) {
      if (!validSession(id) || retired.indexOf(id) >= 0 || active || queue.length) return false;
      if (session !== id) { if (session) cancel(session); session = id; sequence = 0; }
      context = typeof nextContext === 'string' ? nextContext : null; return true;
    },
    cancel,
    enqueue(request) {
      const nav = request.navigation || {}, id = request.requestId;
      if (nav.sessionId !== session || !session) return Promise.resolve(reject('session_changed', 'Refresh phone before swiping'));
      if (!Number.isSafeInteger(nav.sequence) || nav.sequence !== sequence + 1) return Promise.resolve(reject('out_of_order', 'Navigation order changed · Refresh phone'));
      sequence = nav.sequence;
      if (typeof id !== 'string' || id.length >= 96 || !/^fc-[a-z0-9-]+$/.test(id)) return Promise.resolve(reject('bad_request', 'Invalid navigation ID'));
      if (!context || nav.context !== context) return Promise.resolve(reject('context_changed', 'Glasses screen changed · Not sent'));
      if ((active ? 1 : 0) + queue.length >= 4) return Promise.resolve(reject('busy', 'Too many swipes · Not sent'));
      return new Promise(resolve => {
        const at = now(); const item = { operation: request.operation, requestId: id, session, context, at, expiresAt: at + 1000, resolve, timer: null, done: false };
        item.timer = start(() => {
          finish(item, reject('expired', 'Swipe expired · Not sent')); queue = queue.filter(value => value !== item);
        }, 1000);
        queue.push(item); void drain();
      });
    },
  };
}
