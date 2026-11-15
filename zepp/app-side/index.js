import { BaseSideService, settingsLib } from '@zeppos/zml/base-side';
import { createNavigationSide } from '../lib/navigation-side.js';
import { cleanToken, phoneRequest, requestBody, TOKEN_KEY } from '../lib/protocol.js';

let busy = false;
const navigation = createNavigationSide({ send: async (operation, _id, metadata) =>
  phoneRequest(fetch, operation, cleanToken(settingsLib.getItem(TOKEN_KEY)), { navigation: metadata }) });

AppSideService(BaseSideService({
  onCall(message) {
    if (message && message.method === 'FACECLAW_NAV_CANCEL') navigation.cancel(message.params && message.params.sessionId);
  },
  async onRequest(request, response) {
    if (!request || request.method !== 'FACECLAW') { response(null, { ok: false, error: 'Unsupported watch request.' }); return; }
    if (request.navigation) {
      const operation = request.operation;
      if (busy || !operation || operation.kind !== 'gesture' || !/^(swipe-(up|down|left|right)|scroll-(up|down))$/.test(operation.gesture)) {
        response(null, { ok: false, notSent: true, code: 'busy', error: 'Finish the current action first' }); return;
      }
      try {
        const pending = navigation.enqueue(request);
        if (typeof request.requestId === 'string' && request.requestId.length < 96 && /^fc-[a-z0-9-]+$/.test(request.requestId)) {
          try { Promise.resolve(this.call({ method: 'FACECLAW_PROGRESS', params: { requestId: request.requestId, stage: 'phone-received' } })).catch(() => {}); } catch (_) {}
        }
        response(null, await pending);
      } catch (_) { response(null, { ok: false, code: 'unknown', error: 'Result unknown. Check the glasses.' }); }
      return;
    }
    if (busy || navigation.busy()) { response(null, { ok: false, error: 'Phone is busy. Wait, then try again.' }); return; }
    busy = true;
    try {
      const token = cleanToken(settingsLib.getItem(TOKEN_KEY));
      const body = requestBody(request.operation, token);
      const id = request.requestId;
      if (body.action !== 'watch-state' && typeof id === 'string' && id.length < 96 &&
        id === id.trim() && /^fc-[a-z0-9-]+$/.test(id)) {
        // A one-way receipt, not an authorization or a glasses-render report.
        // Progress must never delay, fail, or retry the actual command.
        try {
          Promise.resolve(this.call({ method: 'FACECLAW_PROGRESS', params: { requestId: id, stage: 'phone-received' } })).catch(() => {});
        } catch (_) {}
      }
      const result = await phoneRequest(fetch, request.operation, token);
      if (request.operation.kind === 'state' && result.ok && result.state.navigationSupported) {
        result.state.navigationSupported = navigation.register(request.navSession, result.state.navigationContext);
      }
      response(null, result);
    } catch (error) {
      response(null, { ok: false, error: String(error && error.message || 'No phone reply.').slice(0, 180) });
    } finally { busy = false; }
  },
}));
