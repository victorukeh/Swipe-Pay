import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvSchema } from '../../config/env.schema';
import { CURRENCY_CODES, pegOf } from '../../money/currencies';
import { PrismaService } from '../../prisma/prisma.service';
import type { FxRateProvider, RateTable } from '../fx.types';

/**
 * Last-known-good rates, persisted in Postgres.
 *
 * This is the tier that makes a provider outage survivable *and* survive a
 * restart — a Redis-only cache would be empty after a deploy, which is exactly
 * when you least want to be serving the hardcoded fallback. Every successful
 * live fetch writes here.
 *
 * A snapshot older than FX_SNAPSHOT_MAX_AGE_SECONDS is refused rather than
 * served, so a long outage degrades to the static table (which is honest about
 * being indicative) instead of quoting a week-old rate as if it were current.
 */
@Injectable()
export class SnapshotFxProvider implements FxRateProvider {
  readonly name = 'snapshot';
  private readonly logger = new Logger(SnapshotFxProvider.name);
  private readonly maxAgeMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<EnvSchema, true>,
  ) {
    this.maxAgeMs = config.get('FX_SNAPSHOT_MAX_AGE_SECONDS', { infer: true }) * 1000;
  }

  async fetch(): Promise<RateTable | null> {
    try {
      const rows = await this.prisma.fxRateSnapshot.findMany({ where: { base: 'USD' } });
      if (rows.length === 0) return null;

      const perUsd: Record<string, bigint> = {};
      let oldest: Date | null = null;

      for (const code of CURRENCY_CODES) {
        const peg = pegOf(code);
        const row = rows.find((r) => r.quote === peg);
        if (!row || row.rateScaled <= 0n) return null;
        perUsd[peg] = row.rateScaled;
        if (oldest === null || row.fetchedAt < oldest) oldest = row.fetchedAt;
      }

      if (oldest === null) return null;

      if (Date.now() - oldest.getTime() > this.maxAgeMs) {
        this.logger.warn('Last-known-good FX snapshot is too old to serve');
        return null;
      }

      return { perUsd, asOf: oldest, source: 'stale' };
    } catch (error) {
      this.logger.warn(`Could not read FX snapshot: ${(error as Error).message}`);
      return null;
    }
  }

  /** Persists a freshly fetched table as the new last-known-good. */
  async persist(table: RateTable): Promise<void> {
    try {
      await this.prisma.$transaction(
        Object.entries(table.perUsd).map(([peg, rateScaled]) =>
          this.prisma.fxRateSnapshot.upsert({
            where: { base_quote: { base: 'USD', quote: peg } },
            create: {
              base: 'USD',
              quote: peg,
              rateScaled,
              source: table.source,
              fetchedAt: table.asOf,
            },
            update: { rateScaled, source: table.source, fetchedAt: table.asOf },
          }),
        ),
      );
    } catch (error) {
      // Failing to cache must never fail the caller's money operation.
      this.logger.warn(`Could not persist FX snapshot: ${(error as Error).message}`);
    }
  }
}
