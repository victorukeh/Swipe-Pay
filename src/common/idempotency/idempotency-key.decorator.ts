import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';

import { AppError } from '../errors/app-error';
import { type BorderlessRequest, headerValue } from '../request-context';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Extracts and validates the Idempotency-Key header.
 *
 * Required rather than optional on every money-moving endpoint. Making it
 * optional would mean the safe path is the one a client has to remember, and a
 * payment API that silently double-spends on a network retry is the single worst
 * failure mode available to it. A client that genuinely wants to repeat an
 * operation sends a new key.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<BorderlessRequest>();
    const raw = headerValue(request, IDEMPOTENCY_HEADER)?.trim();

    if (raw === undefined || raw === '') {
      throw AppError.idempotencyKeyRequired();
    }
    if (raw.length > 255) {
      throw AppError.validationFailed({
        issues: ['Idempotency-Key must be at most 255 characters'],
      });
    }

    request.idempotencyKey = raw;
    return raw;
  },
);

/** Documents the header on a route, so Swagger's "Try it out" actually works. */
export const ApiIdempotencyKey = (): MethodDecorator =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'A client-generated unique string, typically a UUID. Retrying with the same key returns ' +
      'the original response instead of moving money twice. Reusing a key with a different body ' +
      'is rejected with IDEMPOTENCY_KEY_REUSED.',
    example: '7f9a2c54-1e3b-4d7a-9f10-2b5c8e4a6d31',
  });
