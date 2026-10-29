import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { EnvSchema } from '../config/env.schema';

/**
 * Redis is used for two things, both of which genuinely need shared state
 * across API instances:
 *
 *  - the token store, so a logout revokes a token everywhere rather than in one
 *    process's memory;
 *  - the FX rate cache, so one provider fetch serves every instance.
 *
 * It is deliberately *not* used for idempotency. An idempotency claim has to be
 * transactional with the ledger write, and a key claimed in Redis could outlive
 * a database rollback and permanently poison the operation. That lives in
 * Postgres.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService<EnvSchema, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });

    this.client.on('error', (error: Error) => {
      // Redis being down must never take the API down: the FX chain falls back
      // to Postgres snapshots and the token store fails closed on auth only.
      this.logger.warn(`Redis error: ${error.message}`);
    });
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }

  async isHealthy(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** Read a key, treating any Redis failure as a cache miss rather than an error. */
  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      this.logger.warn(`Redis GET ${key} failed: ${(error as Error).message}`);
      return null;
    }
  }

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', Math.max(1, seconds));
    } catch (error) {
      this.logger.warn(`Redis SET ${key} failed: ${(error as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (error) {
      this.logger.warn(`Redis DEL failed: ${(error as Error).message}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }
}
