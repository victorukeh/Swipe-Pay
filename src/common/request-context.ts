import type { Request } from 'express';

import type { CurrencyCode } from '../money/currencies';

export const REQUEST_ID_HEADER = 'x-request-id';

/** The authenticated caller, attached by AccessTokenGuard. */
export interface AuthenticatedWallet {
  readonly walletId: string;
  /** JWT id of the presented access token, so logout can revoke exactly it. */
  readonly jti: string;
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

export type { CurrencyCode };
