import { BaseSideService, settingsLib } from '@zeppos/zml/base-side';
import { cleanToken, phoneRequest, TOKEN_KEY } from '../lib/protocol.js';

let busy = false;

AppSideService(BaseSideService({
  async onRequest(request, response) {
    if (!request || request.method !== 'FACECLAW') { response(null, { ok: false, error: 'Unsupported watch request.' }); return; }
    if (busy) { response(null, { ok: false, error: 'Phone is busy. Wait, then try again.' }); return; }
    busy = true;
    try {
      const result = await phoneRequest(fetch, request.operation, cleanToken(settingsLib.getItem(TOKEN_KEY)));
      response(null, result);
    } catch (error) {
      response(null, { ok: false, error: String(error && error.message || 'No phone reply.').slice(0, 180) });
    } finally { busy = false; }
  },
}));
