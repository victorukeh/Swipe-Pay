import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MoneyError } from '../../money/money.error';
import { AppError } from './app-error';
import { ErrorCode } from './error-code';
import { toAppError } from './error-mapper';

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const original = AppError.insufficientFunds({
      currency: 'cNGN',
      requested: '100.00',
      available: '10.00',
    });
    expect(toAppError(original)).toBe(original);
  });

  it('maps money errors onto the public taxonomy', () => {
    const precision = toAppError(
      new MoneyError('AMOUNT_PRECISION_EXCEEDED', 'too precise', { currency: 'cXAF' }),
    );
    expect(precision.code).toBe(ErrorCode.AMOUNT_PRECISION_EXCEEDED);
    expect(precision.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(precision.details).toEqual({ currency: 'cXAF' });

    const invalid = toAppError(new MoneyError('INVALID_AMOUNT', 'nope'));
    expect(invalid.code).toBe(ErrorCode.INVALID_AMOUNT);
    expect(invalid.status).toBe(HttpStatus.BAD_REQUEST);

    // A rate we cannot parse is an upstream problem, not a client one.
    const rate = toAppError(new MoneyError('INVALID_RATE', 'bad rate'));
    expect(rate.code).toBe(ErrorCode.RATE_UNAVAILABLE);
    expect(rate.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(rate.retryable).toBe(true);
  });

  /**
   * Prisma reports `meta.target` as bare column names on PostgreSQL and as the
   * constraint name elsewhere, so both spellings have to resolve to the same
   * client-facing error.
   */
  it.each([
    ['postgres column names', ['email'], 'email'],
    ['a constraint name', ['wallets_email_key'], 'email'],
    ['a bare string target', 'wallets_phone_key', 'phone'],
    ['a phone column', ['phone'], 'phone'],
  ])('turns a unique-constraint violation on %s into contact-taken', (_label, target, field) => {
    const error = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    });
    const mapped = toAppError(error);

    expect(mapped.code).toBe(ErrorCode.WALLET_CONTACT_TAKEN);
    expect(mapped.status).toBe(HttpStatus.CONFLICT);
    expect(mapped.details).toEqual({ field });
    expect(mapped.message).toContain(field);
  });

  it('still reports a conflict for an unrecognised unique constraint', () => {
    const error = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['some_other_key'] },
    });
    const mapped = toAppError(error);

    expect(mapped.code).toBe(ErrorCode.WALLET_CONTACT_TAKEN);
    expect(mapped.status).toBe(HttpStatus.CONFLICT);
    // No index name leaks to the client.
    expect(mapped.message).not.toContain('some_other_key');
  });

  it('never leaks an unrecognised Prisma error to the client', () => {
    const error = new Prisma.PrismaClientKnownRequestError('column "secret_internal" failed', {
      code: 'P2000',
      clientVersion: 'test',
    });
    const mapped = toAppError(error);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(mapped.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mapped.message).not.toContain('secret_internal');
  });

  it('treats a write conflict as transient', () => {
    const mapped = toAppError(
      new Prisma.PrismaClientKnownRequestError('deadlock', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    expect(mapped.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(mapped.retryable).toBe(true);
  });

  it('reports an unreachable database as retryable, not as a client error', () => {
    const mapped = toAppError(
      new Prisma.PrismaClientInitializationError('cannot reach db', 'test'),
    );
    expect(mapped.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(mapped.retryable).toBe(true);
  });

  it('collects ValidationPipe messages into details', () => {
    const mapped = toAppError(
      new BadRequestException({ message: ['amount must be a string', 'currency is invalid'] }),
    );
    expect(mapped.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(mapped.details).toEqual({
      issues: ['amount must be a string', 'currency is invalid'],
    });
  });

  it('maps framework auth exceptions onto our codes', () => {
    expect(toAppError(new UnauthorizedException()).code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(toAppError(new ForbiddenException()).code).toBe(ErrorCode.FORBIDDEN_WALLET_ACCESS);
  });

  it('falls back to INTERNAL_ERROR for anything unrecognised', () => {
    for (const thrown of [new Error('boom'), 'a string', null, undefined, 42]) {
      const mapped = toAppError(thrown);
      expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(mapped.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mapped.retryable).toBe(true);
    }
  });
});

describe('AppError.retryable', () => {
  it('is false for deterministic client failures, so their idempotency key is consumed', () => {
    expect(
      AppError.insufficientFunds({ currency: 'cNGN', requested: '1', available: '0' }).retryable,
    ).toBe(false);
    expect(AppError.sameCurrencySwap('cNGN').retryable).toBe(false);
    expect(AppError.selfTransfer().retryable).toBe(false);
    expect(AppError.unsupportedCurrency('XYZ').retryable).toBe(false);
  });

  it('is true for transient failures, so their idempotency key is released', () => {
    expect(AppError.rateUnavailable().retryable).toBe(true);
    expect(AppError.internal().retryable).toBe(true);
    // An in-flight duplicate is a 409 but the caller should still come back for
    // the replayed response.
    expect(AppError.idempotencyKeyInFlight('k').retryable).toBe(true);
  });

  it('does not reveal whether a contact exists on a failed login', () => {
    expect(AppError.invalidCredentials().message).toBe('Invalid credentials');
  });
});
