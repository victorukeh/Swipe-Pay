import { Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import type { TokenStore } from './token.store';

/**
 * Redis-backed token store.
 *
 * This is why Redis is in the stack at all: a logout has to revoke a token on
 * every API instance, not just the one that served the request, and an
 * in-process map cannot do that.
 *
 * Both key families carry a TTL equal to the token's remaining lifetime, so the
 * store prunes itself — a denylist that grows forever is an availability problem
 * waiting to happen.
 *
 * The refresh side is an allowlist (deny by default) and the access side is a
 * denylist (allow by default). That asymmetry is deliberate: losing the Redis
 * data must never silently extend a long-lived refresh token, whereas an access
 * token expires on its own within minutes anyway.
 */
@Injectable()
export class RedisTokenStore implements TokenStore {
  constructor(private readonly redis: RedisService) {}

  private refreshKey(jti: string, walletId: string): string {
    // The wallet id is part of the key, so a refresh token cannot be replayed
    // against a different wallet even if its jti were guessed.
    return `auth:refresh:${walletId}:${jti}`;
  }

  private accessKey(jti: string): string {
    return `auth:access-revoked:${jti}`;
  }

  async allowRefresh(jti: string, walletId: string, ttlSeconds: number): Promise<void> {
    await this.redis.setEx(this.refreshKey(jti, walletId), ttlSeconds, '1');
  }

  async isRefreshAllowed(jti: string, walletId: string): Promise<boolean> {
    return (await this.redis.get(this.refreshKey(jti, walletId))) !== null;
  }

  async revokeRefresh(jti: string, walletId: string): Promise<void> {
    await this.redis.del(this.refreshKey(jti, walletId));
  }

  async revokeAccess(jti: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.redis.setEx(this.accessKey(jti), ttlSeconds, '1');
  }

  async isAccessRevoked(jti: string): Promise<boolean> {
    return (await this.redis.get(this.accessKey(jti))) !== null;
  }
}
