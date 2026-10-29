import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

import { envelope, type ResponseEnvelope } from '../http/response-envelope';

export const RESPONSE_MESSAGE_KEY = 'borderless:responseMessage';

/**
 * Sets the `requestMessage` for a successful response.
 *
 * Opt-in per route: a generic default would make the field noise, and a field
 * that is always the same carries no information.
 */
export const ResponseMessage = (message: string): MethodDecorator =>
  SetMetadata(RESPONSE_MESSAGE_KEY, message);

/**
 * Wraps every successful response in the standard envelope.
 *
 * Registered globally, so a new controller is enveloped by default rather than
 * by remembering to do it. Failures are enveloped by AllExceptionsFilter, which
 * never runs through an interceptor — both call the same `envelope()` helper so
 * the two paths cannot drift.
 *
 * The status is read back off the response rather than assumed, because the
 * money endpoints set it themselves: a replayed idempotent request returns the
 * status its original attempt returned.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<ResponseEnvelope<unknown>> {
    const response = context.switchToHttp().getResponse<Response>();
    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'Request successful';

    return next.handle().pipe(
      map((data: unknown) =>
        envelope({
          status: response.statusCode,
          message,
          // `undefined` would be dropped by JSON.stringify, leaving the key
          // absent; null keeps the shape stable for a client that always reads it.
          data: data === undefined ? null : data,
        }),
      ),
    );
  }
}
