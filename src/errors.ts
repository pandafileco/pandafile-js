import type { ErrorType } from './generated/types.js';

export interface PandafileErrorInit {
  message: string;
  type?: ErrorType | 'connection_error' | 'signature_verification_error' | 'upload_error';
  code?: string;
  status?: number;
  requestId?: string | null;
  param?: string | null;
  headers?: Record<string, string>;
  raw?: unknown;
  cause?: unknown;
}

/**
 * Every error the SDK throws. `type` is the error category, `code` the stable machine-readable reason
 * (resource_missing, parameter_invalid, plan_required, rate_limited, …), `status` the HTTP status (0 for network errors)
 * and `requestId` the X-Request-Id to quote to support.
 */
export class PandafileError extends Error {
  readonly type: string;
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly param: string | null;
  readonly headers: Record<string, string>;
  /** The parsed error body (or text) as the API sent it. */
  readonly raw: unknown;

  constructor(init: PandafileErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.type = init.type || 'api_error';
    this.code = init.code || 'unknown';
    this.status = init.status ?? 0;
    this.requestId = init.requestId ?? null;
    this.param = init.param ?? null;
    this.headers = init.headers || {};
    this.raw = init.raw;
  }
}

/** 400 / 404 / 409 / 410 / 413: a missing or invalid parameter, an unknown id, or a state that does not allow it. */
export class InvalidRequestError extends PandafileError {}
/** 404: the id does not exist (or belongs to another account / the other mode). */
export class NotFoundError extends InvalidRequestError {}
/** 401: no key, or the key is unknown, revoked or malformed. */
export class AuthenticationError extends PandafileError {}
/** 403: plan, key scope, test mode or team role does not allow this. */
export class PermissionError extends PandafileError {}
/** 409: the Idempotency-Key was used with a different request, or that request is still running. */
export class IdempotencyError extends PandafileError {}
/** 429: too many requests for this key. `retryAfter` is in seconds. */
export class RateLimitError extends PandafileError {
  get retryAfter(): number | null {
    const v = Number(this.headers['retry-after']);
    return Number.isFinite(v) ? v : null;
  }
}
/** 5xx: something went wrong on Pandafile's side. Safe to retry with the same Idempotency-Key. */
export class APIError extends PandafileError {}
/** The request never got an answer (DNS, connection reset, timeout, aborted). */
export class ConnectionError extends PandafileError {}
/** A webhook signature did not verify (wrong secret, modified body or too old). */
export class SignatureVerificationError extends PandafileError {}
/** A tus upload failed for good (after the retries). */
export class UploadError extends PandafileError {}

export function errorFromResponse(status: number, body: unknown, headers: Record<string, string>): PandafileError {
  const requestId = headers['x-request-id'] || null;
  let type: string | undefined, code: string | undefined, message: string | undefined, param: string | null = null;
  const e = (body as { error?: unknown } | null)?.error;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    type = typeof o.type === 'string' ? o.type : undefined;
    code = typeof o.code === 'string' ? o.code : undefined;
    message = typeof o.message === 'string' ? o.message : undefined;
    param = typeof o.param === 'string' ? o.param : null;
  } else if (typeof e === 'string') {
    message = e; // API version 2025-06-01
  }
  type ||= status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error'
    : status >= 500 ? 'api_error' : 'invalid_request_error';
  code ||= status === 404 ? 'resource_missing' : status === 429 ? 'rate_limited' : `http_${status}`;
  message ||= `HTTP ${status}`;
  const init = { message, type: type as ErrorType, code, status, requestId, param, headers, raw: body };
  if (type === 'authentication_error') return new AuthenticationError(init);
  if (type === 'permission_error') return new PermissionError(init);
  if (type === 'idempotency_error') return new IdempotencyError(init);
  if (type === 'rate_limit_error') return new RateLimitError(init);
  if (type === 'api_error') return new APIError(init);
  if (status === 404) return new NotFoundError(init);
  return new InvalidRequestError(init);
}
