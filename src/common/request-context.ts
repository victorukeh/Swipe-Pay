import type { Request } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** The authenticated caller, attached by AccessTokenGuard. */
export interface AuthenticatedWallet {
  readonly walletId: string;
  /** JWT id of the presented access token, so logout can revoke exactly it. */
  readonly jti: string;
  /**
   * The token's `exp` claim, in seconds.
   *
   * Logout denylists the token for exactly its remaining lifetime, so the
   * denylist entry expires with the token instead of accumulating forever.
   */
  readonly expiresAt?: number | undefined;
}

export interface CardtonicRequest extends Request {
  requestId?: string;
  wallet?: AuthenticatedWallet;
  /** Set by the idempotency interceptor from the Idempotency-Key header. */
  idempotencyKey?: string;
}

/** Narrow helper so controllers never deal with `string | string[] | undefined`. */
export function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
