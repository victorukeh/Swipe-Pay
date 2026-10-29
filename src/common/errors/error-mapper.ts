import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MoneyError } from '../../money/money.error';
import { AppError } from './app-error';
import { ErrorCode, type ErrorCodeValue } from './error-code';

const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const SERVER_ERROR: number = HttpStatus.INTERNAL_SERVER_ERROR;

const MONEY_ERROR_STATUS: Record<MoneyError['code'], number> = {
  INVALID_AMOUNT: HttpStatus.BAD_REQUEST,
  AMOUNT_PRECISION_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  AMOUNT_OUT_OF_RANGE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_RATE: HttpStatus.SERVICE_UNAVAILABLE,
};

const MONEY_ERROR_CODE: Record<MoneyError['code'], ErrorCodeValue> = {
  INVALID_AMOUNT: ErrorCode.INVALID_AMOUNT,
  AMOUNT_PRECISION_EXCEEDED: ErrorCode.AMOUNT_PRECISION_EXCEEDED,
  AMOUNT_OUT_OF_RANGE: ErrorCode.AMOUNT_OUT_OF_RANGE,
  INVALID_RATE: ErrorCode.RATE_UNAVAILABLE,
};

/**
 * Unique-constraint violations, mapped to the error the client should see.
 *
 * Keyed on both the constraint name and the bare column name, because Prisma
 * reports `meta.target` as one or the other depending on the adapter and
 * version -- PostgreSQL gives `['email']` here, while the constraint name shows
 * up in other configurations. Matching both means the client gets "a wallet
 * already exists for that email" rather than a vague fallback.
 */
const UNIQUE_CONSTRAINT_ERRORS: Record<string, () => AppError> = {
  email: () => AppError.walletContactTaken('email'),
  phone: () => AppError.walletContactTaken('phone'),
  wallets_email_key: () => AppError.walletContactTaken('email'),
  wallets_phone_key: () => AppError.walletContactTaken('phone'),
};

/**
 * Normalises everything thrown anywhere in the app into an AppError.
 *
 * Isolated from the filter so it can be unit-tested without an HTTP context, and
 * so there is exactly one place that decides how a foreign error becomes a
 * response. A Prisma error must never reach the client: `P2002` leaks index
 * names and `P2003` leaks the schema's shape.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof MoneyError) {
    return new AppError({
      code: MONEY_ERROR_CODE[error.code],
      status: MONEY_ERROR_STATUS[error.code],
      message: error.message,
      details: error.details,
      cause: error,
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return fromPrisma(error);
  }

  // A Prisma validation error means we built a bad query: our bug, not theirs.
  if (
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return AppError.internal(error);
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'Database is unavailable',
      retryable: true,
      cause: error,
    });
  }

  // Exceptions raised by Nest itself (the validation pipe, route guards, 404s).
  if (error instanceof HttpException) {
    return fromHttpException(error);
  }

  return AppError.internal(error);
}

function fromPrisma(error: Prisma.PrismaClientKnownRequestError): AppError {
  switch (error.code) {
    case 'P2002': {
      const target: unknown = error.meta?.['target'];
      const name =
        Array.isArray(target) && typeof target[0] === 'string'
          ? target[0]
          : typeof target === 'string'
            ? target
            : '';
      const mapped = UNIQUE_CONSTRAINT_ERRORS[name];
      if (mapped) return mapped();
      return new AppError({
        code: ErrorCode.WALLET_CONTACT_TAKEN,
        status: HttpStatus.CONFLICT,
        message: 'That value is already in use',
        cause: error,
      });
    }
    case 'P2025':
      // "An operation failed because it depends on one or more records that were
      // required but not found."
      return AppError.walletNotFound();
    case 'P2034':
      // Write conflict or deadlock. We take locks in a deterministic order so
      // this should not happen; if it does, it is transient and retryable.
      return new AppError({
        code: ErrorCode.INTERNAL_ERROR,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Write conflict; please retry',
        retryable: true,
        cause: error,
      });
    default:
      return AppError.internal(error);
  }
}

function fromHttpException(error: HttpException): AppError {
  const status = error.getStatus();
  const response = error.getResponse();

  // The ValidationPipe puts its messages in `message` as a string array.
  if (status === BAD_REQUEST && typeof response === 'object' && response !== null) {
    const body = response as { message?: unknown };
    if (Array.isArray(body.message)) {
      return AppError.validationFailed({ issues: body.message.map(String) });
    }
  }

  if (status === UNAUTHORIZED) return AppError.unauthenticated();
  if (status === FORBIDDEN) return AppError.forbiddenWalletAccess();

  return new AppError({
    code: status >= SERVER_ERROR ? ErrorCode.INTERNAL_ERROR : ErrorCode.VALIDATION_FAILED,
    status,
    message: error.message,
    cause: error,
  });
}
