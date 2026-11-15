// Scoped to @zeppos/zml 0.0.43 (pinned in package.json). Keep BasePage.request's
// cross-context result bridge and ZML's framing; cache its phone-service port.
// Only this app's FACECLAW JSON requests use the cancellation/send guards.
const SLOT = '__faceclawSession043';

function failure(reason, sent = false) {
  const error = new Error(reason);
  error.reason = reason; error.sessionSent = sent; error.notSent = !sent;
  return error;
}

function compatible(messaging) {
  const t = messaging && messaging.transport;
  return !!(t && ['fork', 'request', 'sendJson', 'onResponse', 'onFragmentData',
    'readBin', 'errorIfBleDisconnect', 'clearShakeTimer', 'on', 'off'].every(name => typeof t[name] === 'function') &&
    t.handlers && typeof t.handlers.get === 'function' && typeof t.handlers.clear === 'function' &&
    t.ble && typeof t.ble.connectStatus === 'function');
}

export function createMessagingSession(messaging) {
  if (!compatible(messaging)) {
    // A different ZML release retains its original transport, without guessing
    // at internals. The dependency/version regression test prevents silent drift.
    return { supported: false, setAwake() {}, invalidate() {}, dispose() {},
      snapshot: () => ({ supported: false, ready: false, validated: false }) };
  }
  const t = messaging.transport;
  if (t[SLOT]) { t[SLOT].attach(); return t[SLOT].controller; }
  const original = {};
  for (const name of ['fork', 'request', 'sendJson', 'onResponse', 'onFragmentData']) original[name] = t[name];
  let epoch = 0, awake = true, disposed = false, ready = null, validated = null, handshake = null;
  let lastBle = !!t.ble.connectStatus();
  const tickets = new Map();
  const active = () => awake && !disposed;
  const same = ticket => active() && ticket.epoch === epoch && !ticket.done;
  const goodPort = port => !!port && t.shakeStatus === 3 && t.appSidePort === port && !!t.ble.connectStatus();
  const readyNow = () => !!(ready && ready.epoch === epoch && goodPort(ready.port));
  const validatedNow = () => !!(readyNow() && validated && validated.epoch === epoch && validated.port === ready.port);

  function finish(ticket, error, value) {
    if (ticket.done) return;
    ticket.done = true;
    if (error) ticket.reject(error); else ticket.resolve(value);
  }
  function invalidate(reason = 'Connection changed') {
    epoch++; ready = null; validated = null;
    for (const ticket of tickets.values()) {
      if (ticket.done) continue;
      const error = failure(reason, ticket.sent);
      finish(ticket, error);
      if (ticket.task) ticket.task.reject(error);
    }
    // Do not tear down ZML listeners or replace a pending handshake. Its late
    // completion may settle old promises, but cannot authorize this new epoch.
  }
  function trackHandshake(promise, attempt) {
    attempt.promise = promise; handshake = attempt;
    promise.then(() => {
      attempt.settled = true;
      if (active() && attempt.epoch === epoch && goodPort(t.appSidePort)) ready = { epoch, port: t.appSidePort };
    }, () => {
      attempt.settled = true;
      if (handshake === attempt) t.clearShakeTimer();
      if (attempt.epoch === epoch) invalidate('Phone connection failed');
    });
    return promise;
  }
  t.fork = function (timeout) {
    if (!active()) return this.waitingShakePromise || Promise.resolve();
    if (readyNow()) return this.waitingShakePromise;
    if (ready) invalidate('Phone service changed');
    if (handshake && !handshake.settled) return handshake.promise;
    if (this.shakeStatus === 2 && this.waitingShakePromise) {
      // A handshake that predates attachment is allowed to finish, not reused.
      return trackHandshake(this.waitingShakePromise, { epoch: -1, settled: false });
    }
    const attempt = { epoch, settled: false };
    handshake = attempt;
    let promise;
    // Start discovery at the runtime, not the port of a stopped phone service.
    this.appSidePort = 0;
    try { promise = original.fork.call(this, timeout); }
    catch (error) {
      // Stock fork can throw after creating its deferred/timer when BLE send
      // fails. Settle that same deferred so request() gets a normal rejection.
      this.clearShakeTimer(); this.shakeStatus = 4;
      if (this.shakeTask) this.shakeTask.reject(error);
      promise = this.waitingShakePromise || Promise.reject(error);
    }
    return trackHandshake(promise, attempt);
  };
  t.request = function (data, options) {
    if (!data || data.method !== 'FACECLAW' || data.jsonrpc !== 'hmrpcv1') return original.request.call(this, data, options);
    if (!active()) return Promise.reject(failure('Watch screen is off'));
    if (handshake && !handshake.settled && handshake.epoch !== epoch) return Promise.reject(failure('Connection is resetting; refresh again'));
    const read = !!(data.operation && data.operation.kind === 'state');
    if (!read && !validatedNow()) return Promise.reject(failure('Refresh the connection before sending'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const ticket = { epoch, read, sent: false, done: false, task: null, resolve, reject };
    tickets.set(data, ticket);
    let pending;
    try { pending = original.request.call(this, data, options); }
    catch (error) { pending = Promise.reject(error); }
    pending.then(payload => {
      if (same(ticket) && read && readyNow() && payload && payload.jsonrpc === 'hmrpcv1' && !payload.error &&
          payload.result && payload.result.ok === true && payload.result.state) validated = { epoch, port: ready.port };
      if (same(ticket)) finish(ticket, null, payload);
      else finish(ticket, failure('Connection changed', ticket.sent));
    }, error => {
      if (ticket.epoch === epoch) invalidate((error && (error.reason || error.message)) || 'Phone request failed');
      finish(ticket, error);
    }).finally(() => { if (tickets.get(data) === ticket) tickets.delete(data); });
    return promise;
  };
  t.sendJson = function (args) {
    const ticket = args.type === 1 && tickets.get(args.json);
    if (!ticket) return original.sendJson.call(this, args);
    const entry = this.handlers.get(args.requestId);
    ticket.task = entry && entry.task;
    try {
      // This runs immediately before ZML sends, after its asynchronous handshake
      // wait. Checking only at request entry would allow a gesture after sleep.
      if (!same(ticket) || !readyNow() || (!ticket.read && !validatedNow())) throw failure('Not sent: connection changed');
      ticket.sent = true; // A native send failure can mean partial/unknown delivery.
      return original.sendJson.call(this, args);
    } catch (error) {
      if (error.sessionSent === undefined) { error.sessionSent = ticket.sent; error.notSent = !ticket.sent; }
      if (ticket.task) ticket.task.reject(error);
      else finish(ticket, error);
      // Do not throw synchronously: stock request installs cleanup AFTER sendJson.
    }
  };
  t.onResponse = function (packet) {
    const entry = this.handlers.get(packet.traceId);
    if (!entry || typeof entry.handler !== 'function') return; // Late/expired reply.
    try { return original.onResponse.call(this, packet); }
    catch (error) { if (entry.task) entry.task.reject(error); }
  };
  t.onFragmentData = function (data) {
    const packet = this.readBin(data);
    if (packet.flag === 1 && packet.type === 1) {
      // Ignore unsolicited/late completed handshakes. ZML's wire handshake has
      // no nonce, so every new epoch also requires a successful read-only state
      // round trip before any mutation can use its discovered port.
      if (!handshake || handshake.settled || this.shakeStatus !== 2) {
        if (ready && packet.port2 !== ready.port) invalidate('Phone service changed');
        return;
      }
    } else if (packet.flag === 1 && packet.type === 2) invalidate('Phone service closed');
    return original.onFragmentData.call(this, data);
  };
  t.on('bleStatusChanged', status => {
    const connected = !!status;
    if (!connected || connected !== lastBle) invalidate(connected ? 'Phone reconnected' : 'Phone disconnected');
    lastBle = connected;
  });
  const controller = {
    supported: true,
    setAwake(value) {
      const next = !!value;
      if (next === awake || disposed) return;
      awake = next; invalidate(next ? 'Watch woke up' : 'Watch screen is off');
    },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true; awake = false; invalidate('Watch app closed');
      // Keep send guards installed until BaseApp tears down. Restoring methods
      // here would let a delayed handshake dispatch an obsolete gesture.
    },
    snapshot: () => ({ supported: true, awake: active(), epoch, ready: readyNow(), validated: validatedNow(),
      pending: [...tickets.values()].filter(ticket => !ticket.done).length }),
  };
  t[SLOT] = { controller, attach() {
    if (!disposed) return;
    disposed = false; awake = true; invalidate('Watch app opened');
  } };
  return controller;
}
