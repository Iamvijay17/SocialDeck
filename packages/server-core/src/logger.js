import pino from 'pino';

/**
 * Structured logging with credential redaction. Redaction is defence in depth: code should never log
 * secrets in the first place, and tests assert that known secret values never reach the log output.
 */
const REDACT_KEYS = [
  'password',
  'passwordHash',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'secret',
  'credentials',
  'setupToken',
  'authorization',
  'cookie',
  'csrfToken',
  'encryptionKey',
  'dpopJwk',
  'value',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  ...REDACT_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
];

const TOKEN_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:access|refresh)_?token["'=:\s]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(client_secret["'=:\s]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(osh_session=)[A-Za-z0-9._~-]+/gi,
];

/** Scrub token-looking substrings from free-form strings such as error messages. */
export function scrubSecrets(text) {
  let out = String(text ?? '');
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '$1[REDACTED]');
  return out;
}

function errSerializer(err) {
  if (!err || typeof err !== 'object') return err;
  return {
    type: err.name,
    message: scrubSecrets(err.message),
    code: err.code,
    status: err.status,
    stack: err.stack ? scrubSecrets(err.stack) : undefined,
  };
}

export function createLogger({ level = 'info', name = 'osh', destination } = {}) {
  return pino(
    {
      name,
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { err: errSerializer, error: errSerializer },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
