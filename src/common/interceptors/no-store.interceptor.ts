import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * Authenticated routes resolve differently per caller — GET /wallets returns
 * *your* wallet — so the response must never be cached or reused by an
 * intermediary. Without `Vary: Authorization` a shared cache is entitled to
 * serve one wallet's balances to another.
 */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Authorization');
    return next.handle();
  }
}
