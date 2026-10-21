import { ERROR_CLASS } from '@osh/shared';
import { PlatformAdapter, defineCapabilities } from './adapter.js';
import { PlatformError } from './errors.js';

/**
 * Factory for integrations that are documented but not implemented. The resulting adapter reports
 * `implemented: false`, so the UI marks it "planned" and the publishing engine refuses to use it.
 * Nothing here claims the platform works.
 *
 * @param {object} def
 * @param {string} def.id
 * @param {string} def.label
 * @param {string} def.docsUrl official documentation
 * @param {string[]} def.notes eligibility / access requirements to show users
 * @param {string[]} [def.requiredScopes]
 * @param {object} [def.capabilities] declared (planned) capabilities
 */
export function createStubAdapter({ id, label, docsUrl, notes, requiredScopes = [], capabilities = {} }) {
  const caps = defineCapabilities({
    ...capabilities,
    implemented: false,
    requiredScopes,
    notes,
    docsUrl,
  });

  return class StubAdapter extends PlatformAdapter {
    get id() {
      return id;
    }
    get label() {
      return label;
    }
    get capabilities() {
      return caps;
    }
    async beginAuthorization() {
      throw unavailable(label);
    }
    async completeAuthorization() {
      throw unavailable(label);
    }
    validateContent() {
      return [{ code: 'integration_unavailable', severity: 'error', message: `${label} publishing is not implemented yet.` }];
    }
    async publish() {
      throw unavailable(label);
    }
  };
}

function unavailable(label) {
  return new PlatformError(`The ${label} integration is not implemented yet.`, {
    kind: ERROR_CLASS.PERMANENT,
    code: 'integration_unavailable',
  });
}
