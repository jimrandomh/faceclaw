import { BaseSideService, settingsLib } from '@zeppos/zml/base-side';
import { cleanToken, phoneRequest, requestBody, TOKEN_KEY } from '../lib/protocol.js';

let busy = false;

AppSideService(BaseSideService({
  async onRequest(request, response) {
    if (!request || request.method !== 'FACECLAW') { response(null, { ok: false, error: 'Unsupported watch request.' }); return; }
    if (busy) { response(null, { ok: false, error: 'Phone is busy. Wait, then try again.' }); return; }
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
      response(null, result);
    } catch (error) {
      response(null, { ok: false, error: String(error && error.message || 'No phone reply.').slice(0, 180) });
    } finally { busy = false; }
  },
}));
