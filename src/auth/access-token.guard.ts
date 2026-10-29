import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/errors/app-error';
import type { CardtonicRequest } from '../common/request-context';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Registered globally, so every route is authenticated unless it opts out with
 * `@Public()`.
 *
 * Deny-by-default is the only safe arrangement for a money API: forgetting a
 * decorator then makes an endpoint unreachable rather than silently open.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<CardtonicRequest>();
    const header = request.headers.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw AppError.unauthenticated('A Bearer access token is required');
    }

    const claims = await this.auth.verifyAccess(header.slice('Bearer '.length).trim());

    // The handler reads the wallet from here via @CurrentWallet. No route takes
    // a wallet id from the client, so none can be pointed at another wallet.
    request.wallet = { walletId: claims.sub, jti: claims.jti, expiresAt: claims.exp };
    return true;
  }
}
