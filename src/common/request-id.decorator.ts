import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { BorderlessRequest } from './request-context';

/**
 * The correlation id assigned by RequestIdMiddleware.
 *
 * Recorded on every attempt, so an operator can take the request id out of a
 * client's error report and find the exact money operation behind it.
 */
export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<BorderlessRequest>();
    return request.requestId ?? 'unknown';
  },
);
