import { HttpStatus } from '@nestjs/common';

import { ErrorCode, type ErrorCodeValue } from './error-code';

/**
 * The one error type the domain throws.
 *
 * Carrying both the stable `code` and the HTTP status on the error keeps the
 * mapping in one place instead of scattering `throw new BadRequestException(...)`
 * across services, and lets the exception filter stay dumb.
 *
 * `retryable` drives idempotency behaviour, which is the subtle part. A
 * deterministic failure (insufficient funds) will fail identically on retry, so
 * its key is consumed and the stored error is replayed. A transient failure (the
 * FX provider timed out) might succeed on retry, so its key is released. Getting
 * this backwards either poisons an operation forever or lets a retry double-spend.
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(params: {
    code: ErrorCodeValue;
    status: number;
    message: string;
    details?: Record<string, unknown>;
    /** True for transient failures. Defaults to true for 5xx, false otherwise. */
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'AppError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details ?? {};
    this.retryable = params.retryable ?? params.status >= 500;
  }

  static validationFailed(details: Record<string, unknown>): AppError {
    return new AppError({
      code: ErrorCode.VALIDATION_FAILED,
      status: HttpStatus.BAD_REQUEST,
      message: 'Request validation failed',
      details,
    });
  }

  static unsupportedCurrency(currency: unknown): AppError {
    return new AppError({
      code: ErrorCode.UNSUPPORTED_CURRENCY,
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Unsupported currency',
      details: { currency },
    });
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError({
      code: ErrorCode.UNAUTHENTICATED,
      status: HttpStatus.UNAUTHORIZED,
      message,
    });
  }

  static invalidCredentials(): AppError {
    return new AppError({
      code: ErrorCode.INVALID_CREDENTIALS,
      status: HttpStatus.UNAUTHORIZED,
      // Deliberately does not say whether the contact exists: that would turn
      // the login endpoint into a wallet-enumeration oracle.
      message: 'Invalid credentials',
    });
  }

  static tokenExpired(): AppError {
    return new AppError({
      code: ErrorCode.TOKEN_EXPIRED,
      status: HttpStatus.UNAUTHORIZED,
      message: 'Token has expired',
    });
  }

  static tokenRevoked(): AppError {
    return new AppError({
      code: ErrorCode.TOKEN_REVOKED,
      status: HttpStatus.UNAUTHORIZED,
      message: 'Token has been revoked',
    });
  }

  static tokenWrongType(expected: 'access' | 'refresh'): AppError {
    return new AppError({
      code: ErrorCode.TOKEN_WRONG_TYPE,
      status: HttpStatus.UNAUTHORIZED,
      message: `Expected ${expected} token`,
      details: { expected },
    });
  }

  static forbiddenWalletAccess(): AppError {
    return new AppError({
      code: ErrorCode.FORBIDDEN_WALLET_ACCESS,
      status: HttpStatus.FORBIDDEN,
      message: 'This wallet is not a party to the requested resource',
    });
  }

  static walletNotFound(walletId?: string): AppError {
    return new AppError({
      code: ErrorCode.WALLET_NOT_FOUND,
      status: HttpStatus.NOT_FOUND,
      message: 'Wallet not found',
      details: walletId === undefined ? {} : { walletId },
    });
  }

  static transactionNotFound(id?: string): AppError {
    return new AppError({
      code: ErrorCode.TRANSACTION_NOT_FOUND,
      status: HttpStatus.NOT_FOUND,
      message: 'Transaction not found',
      details: id === undefined ? {} : { transactionId: id },
    });
  }

  static walletContactTaken(field: 'email' | 'phone'): AppError {
    return new AppError({
      code: ErrorCode.WALLET_CONTACT_TAKEN,
      status: HttpStatus.CONFLICT,
      message: `A wallet already exists for that ${field}`,
      details: { field },
    });
  }

  static idempotencyKeyInFlight(key: string): AppError {
    return new AppError({
      code: ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT,
      status: HttpStatus.CONFLICT,
      message: 'An operation with this Idempotency-Key is still in progress',
      details: { idempotencyKey: key },
      // The original may yet succeed, so the client should retry and collect the
      // replayed response rather than treat this as a final answer.
      retryable: true,
    });
  }

  static idempotencyKeyRequired(): AppError {
    return new AppError({
      code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      status: HttpStatus.BAD_REQUEST,
      message: 'The Idempotency-Key header is required for this operation',
    });
  }

  static idempotencyKeyReused(key: string): AppError {
    return new AppError({
      code: ErrorCode.IDEMPOTENCY_KEY_REUSED,
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'This Idempotency-Key was already used for a different request body',
      details: { idempotencyKey: key },
    });
  }

  static insufficientFunds(params: {
    currency: string;
    requested: string;
    available: string;
  }): AppError {
    return new AppError({
      code: ErrorCode.INSUFFICIENT_FUNDS,
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Insufficient funds',
      details: params,
    });
  }

  static sameCurrencySwap(currency: string): AppError {
    return new AppError({
      code: ErrorCode.SAME_CURRENCY_SWAP,
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'A swap must be between two different currencies',
      details: { currency },
    });
  }

  static selfTransfer(): AppError {
    return new AppError({
      code: ErrorCode.SELF_TRANSFER,
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Cannot transfer to the sending wallet; use a swap instead',
    });
  }

  static amountTooSmallToConvert(params: { from: string; to: string; amount: string }): AppError {
    return new AppError({
      code: ErrorCode.AMOUNT_TOO_SMALL_TO_CONVERT,
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      // Rejecting beats debiting the source and crediting nothing.
      message: 'Amount converts to zero in the destination currency',
      details: params,
    });
  }

  static rateUnavailable(details: Record<string, unknown> = {}): AppError {
    return new AppError({
      code: ErrorCode.RATE_UNAVAILABLE,
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'No exchange rate is currently available for this pair',
      details,
      retryable: true,
    });
  }

  static invalidCursor(): AppError {
    return new AppError({
      code: ErrorCode.INVALID_CURSOR,
      status: HttpStatus.BAD_REQUEST,
      message: 'Malformed pagination cursor',
    });
  }

  /**
   * Rebuilds an error from an idempotency record.
   *
   * A deterministic failure is replayed by re-raising it, not by returning the
   * stored envelope as a response body: that way the reply goes through the
   * normal exception filter and carries the *current* request's correlation id,
   * while the code, message and details stay byte-identical to the first answer.
   */
  static fromStoredFailure(stored: { status: number; body: unknown }): AppError {
    const envelope = stored.body as
      { error?: { code?: unknown; message?: unknown; details?: unknown } } | null | undefined;
    const error = envelope?.error;

    return new AppError({
      code: (typeof error?.code === 'string'
        ? error.code
        : ErrorCode.INTERNAL_ERROR) as ErrorCodeValue,
      status: stored.status,
      message: typeof error?.message === 'string' ? error.message : 'Request previously failed',
      details:
        error?.details !== null && typeof error?.details === 'object'
          ? (error.details as Record<string, unknown>)
          : {},
      // Stored failures are only ever the deterministic ones, by construction:
      // a transient failure releases its key instead of recording a response.
      retryable: false,
    });
  }

  static internal(cause?: unknown): AppError {
    return new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred',
      retryable: true,
      cause,
    });
  }
}
