import { badRequest } from '@osh/shared';
import { assertSafeUrl } from '@osh/platform-core';
import { AppSetting } from '../models/index.js';

const PUBLIC_MEDIA_KEY = 'publicMediaBaseUrl';

/**
 * Runtime settings. The only one today is the public base URL of the media gateway (a Cloudflare quick-tunnel
 * address changes on every start, so it must be editable without redeploying).
 */
export function createSettingsService({ config, fetch, audit }) {
  const service = {
    /** Normalised https origin (+ optional path prefix) or null. Stored value wins over PUBLIC_MEDIA_BASE_URL. */
    async publicMediaBaseUrl() {
      const doc = await AppSetting.findOne({ key: PUBLIC_MEDIA_KEY }).lean();
      return doc?.value ?? config.media.publicBaseUrl ?? null;
    },

    normaliseMediaBaseUrl(input) {
      let url;
      try {
        url = assertSafeUrl(String(input).trim());
      } catch (err) {
        throw badRequest(`Enter a public https:// address. ${err.message}.`);
      }
      if (url.protocol !== 'https:') throw badRequest('The public media address must use https://.');
      if (url.search || url.hash) throw badRequest('Remove the query string or fragment from the address.');
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    },

    async setPublicMediaBaseUrl(input, { actorId, requestId } = {}) {
      const value = input ? service.normaliseMediaBaseUrl(input) : null;
      if (value) await AppSetting.updateOne({ key: PUBLIC_MEDIA_KEY }, { $set: { value } }, { upsert: true });
      else await AppSetting.deleteOne({ key: PUBLIC_MEDIA_KEY });
      await audit.record({ actorId, action: 'settings.public_media_url', resourceType: 'settings', metadata: { configured: Boolean(value) }, requestId });
      return { baseUrl: await service.publicMediaBaseUrl() };
    },

    /** Check, from this machine, that the gateway answers on the public address (a necessary, not sufficient, test). */
    async testPublicMediaBaseUrl(input) {
      const base = input ? service.normaliseMediaBaseUrl(input) : await service.publicMediaBaseUrl();
      if (!base) return { configured: false, reachable: false, message: 'No public media address is set.' };
      try {
        const res = await fetch(`${base}/healthz`, { method: 'GET', headers: { accept: 'text/plain' } });
        const isGateway = res.headers.get('x-socialdeck-gateway') === '1';
        await res.body?.cancel();
        if (res.ok && isGateway) return { configured: true, reachable: true, message: 'The media gateway answered over HTTPS.' };
        if (res.ok) return { configured: true, reachable: false, message: 'Something answered, but it is not the media gateway. Point the tunnel at port 4100 (the gateway), not the dashboard.' };
        return { configured: true, reachable: false, message: `The address answered with HTTP ${res.status}. Is the tunnel pointing at the gateway?` };
      } catch (err) {
        return { configured: true, reachable: false, message: `Could not reach ${base}: ${err.code ?? err.message}` };
      }
    },
  };
  return service;
}
