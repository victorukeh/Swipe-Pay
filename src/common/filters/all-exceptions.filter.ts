import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { toAppError } from '../errors/error-mapper';
import { type CardtonicRequest } from '../request-context';

const SERVER_ERROR: number = HttpStatus.INTERNAL_SERVER_ERROR;

/** The single error shape this API returns. Documented in the README and OpenAPI spec. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId: string;
    /** True when retrying the identical request could succeed. */
    retryable: boolean;
  };
}

/**
 * One filter, one response shape, for every failure in the app.
 *
 * Two things it deliberately does:
 *
 *  - 5xx responses carry a generic message. The real error and its stack go to
 *    the log against the request id, so support can correlate without the
 *    client ever seeing an internal detail or a leaked index name.
 *  - `retryable` is published, so a client knows whether a retry is pointless
 *    (insufficient funds) or sensible (rate provider down). It mirrors exactly
 *    the signal that decides whether an Idempotency-Key is consumed or released.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<CardtonicRequest>();
    const response = http.getResponse<Response>();

    const appError = toAppError(exception);
    const requestId = request.requestId ?? 'unknown';
    const isServerError = appError.status >= SERVER_ERROR;

    const context = `${request.method} ${request.originalUrl} [${requestId}]`;
    if (isServerError) {
      this.logger.error(
        `${context} -> ${appError.status} ${appError.code}: ${appError.message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${context} -> ${appError.status} ${appError.code}: ${appError.message}`);
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: appError.code,
        message: isServerError ? 'An unexpected error occurred' : appError.message,
        details: isServerError ? {} : appError.details,
        requestId,
        retryable: appError.retryable,
      },
    };

    response.status(appError.status).json(envelope);
  }
}
