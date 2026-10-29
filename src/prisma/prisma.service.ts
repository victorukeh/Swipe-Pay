import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { EnvSchema } from '../config/env.schema';

/**
 * A Prisma transaction client. Every method that writes money takes one of these
 * rather than the root client, which makes it impossible to accidentally perform
 * a ledger write outside a transaction.
 */
export type PrismaTx = Omit<
  PrismaClient,
  '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'
>;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<EnvSchema, true>) {
    super({
      datasources: { db: { url: config.get('DATABASE_URL', { infer: true }) } },
      log:
        config.get('NODE_ENV', { infer: true }) === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * READ COMMITTED plus explicit `SELECT ... FOR UPDATE` row locks, rather than
   * SERIALIZABLE.
   *
   * Both are correct here, but SERIALIZABLE would push the problem into
   * serialization failures that have to be caught and retried — retry logic that
   * is easy to get subtly wrong and hard to test. Taking the locks ourselves,
   * always in the same order, means a conflicting writer simply waits.
   */
  async inTransaction<T>(fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return this.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      // Long enough to absorb a lock wait under the concurrency tests, short
      // enough that a genuinely stuck transaction gives up rather than pinning a
      // connection forever.
      timeout: 15_000,
      maxWait: 10_000,
    });
  }

  /** True when the database is reachable. Used by the health endpoint. */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
