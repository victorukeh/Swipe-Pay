/**
 * Every failure this API can return, as a stable machine-readable code.
 *
 * Clients branch on `code`, never on `message` or on the HTTP status alone.
 * Three different things return 422 and a client needs to tell them apart. The
 * codes are part of the public contract: the README documents each one with its
 * cause, and there is a test per code.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Amount was not a well-formed unsigned decimal string. */
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  /** Amount carried more decimal places than the currency admits. */
  AMOUNT_PRECISION_EXCEEDED: 'AMOUNT_PRECISION_EXCEEDED',
  /** Amount, or the result of converting it, cannot be stored. */
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',

  /** No credentials, or a token that cannot be verified. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Credentials did not match an existing wallet. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Token signature was valid but its lifetime has passed. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** Token was explicitly revoked by logout or by refresh rotation. */
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  /** A refresh token was presented where an access token was required, or vice versa. */
  TOKEN_WRONG_TYPE: 'TOKEN_WRONG_TYPE',

  /** Caller is authenticated but is not a party to the requested resource. */
  FORBIDDEN_WALLET_ACCESS: 'FORBIDDEN_WALLET_ACCESS',

  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',

  /** The email or phone number already belongs to another wallet. */
  WALLET_CONTACT_TAKEN: 'WALLET_CONTACT_TAKEN',

  /** An operation with this Idempotency-Key is still running. */
  IDEMPOTENCY_KEY_IN_FLIGHT: 'IDEMPOTENCY_KEY_IN_FLIGHT',
  /** This Idempotency-Key was already used for a materially different request. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** The Idempotency-Key header is required on this endpoint and was absent. */
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',

  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  /** A swap must change currency; swapping cNGN for cNGN is a no-op, not a trade. */
  SAME_CURRENCY_SWAP: 'SAME_CURRENCY_SWAP',
  /** A transfer must have a counterparty other than the sender. */
  SELF_TRANSFER: 'SELF_TRANSFER',
  /** The conversion rounded down to zero in the destination currency. */
  AMOUNT_TOO_SMALL_TO_CONVERT: 'AMOUNT_TOO_SMALL_TO_CONVERT',

  /** Every tier of the FX chain failed; no rate could be established. */
  RATE_UNAVAILABLE: 'RATE_UNAVAILABLE',

  /** Malformed pagination cursor. */
  INVALID_CURSOR: 'INVALID_CURSOR',

  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
