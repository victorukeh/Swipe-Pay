import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { AppError } from '../common/errors/app-error';
import type { AuthenticatedWallet, BorderlessRequest } from '../common/request-context';

/**
 * Injects the authenticated wallet into a handler.
 *
 * This is the mechanism that replaces a `:walletId` path parameter. The caller's
 * wallet comes from the verified token, so there is no route a client can point
 * at someone else's wallet, and no handler that has to remember an ownership
 * check.
 */
export const CurrentWallet = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedWallet => {
    const request = context.switchToHttp().getRequest<BorderlessRequest>();
    if (!request.wallet) {
      // Only reachable if a handler used this decorator on a @Public route.
      throw AppError.unauthenticated();
    }
    return request.wallet;
  },
);
