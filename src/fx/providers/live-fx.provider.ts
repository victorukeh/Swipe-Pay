import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvSchema } from '../../config/env.schema';
import { CurrencyRegistry } from '../../money/currency-registry.service';
import { MoneyUtil } from '../../money/money.util';
import type { FxRateProvider, RateTable } from '../fx.types';

/** Shape of the open.er-api.com response we rely on. */
interface ProviderResponse {
  result?: string;
  base_code?: string;
  time_last_update_unix?: number;
  rates?: Record<string, number>;
}

/**
 * Live rates from open.er-api.com.
 *
 * Chosen because it is free, needs no API key (so a reviewer can run this repo
 * without signing up for anything) and covers all five pegs we need including
 * NGN, GHS and XAF — most free providers are ECB-derived and carry none of the
 * African currencies.
 *
 * Every failure mode returns null rather than throwing, because "no rate from
 * this provider" is an expected condition that the next tier handles, not an
 * error. The request is bounded by an AbortController: a provider that hangs is
 * worse than one that refuses, since it would hold the caller's transaction open.
 */
@Injectable()
export class LiveFxProvider implements FxRateProvider {
  readonly name = 'live';
  private readonly logger = new Logger(LiveFxProvider.name);
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly currencies: CurrencyRegistry,
    config: ConfigService<EnvSchema, true>,
  ) {
    this.url = config.get('FX_PROVIDER_URL', { infer: true });
    this.timeoutMs = config.get('FX_PROVIDER_TIMEOUT_MS', { infer: true });
  }

  async fetch(): Promise<RateTable | null> {
    if (!this.url) {
      // Deliberately configurable to empty, so the fallback chain can be
      // exercised in development and in tests.
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await globalThis.fetch(this.url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        this.logger.warn(`FX provider returned HTTP ${response.status}`);
        return null;
      }

      const body = (await response.json()) as ProviderResponse;
      return this.toRateTable(body);
    } catch (error) {
      this.logger.warn(`FX provider unreachable: ${(error as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private toRateTable(body: ProviderResponse): RateTable | null {
    if (body.result !== undefined && body.result !== 'success') {
      this.logger.warn(`FX provider reported result="${body.result}"`);
      return null;
    }
    if (body.base_code !== undefined && body.base_code !== 'USD') {
      // Every derivation assumes a USD base; silently accepting another base
      // would invert every rate in the system.
      this.logger.warn(`FX provider changed base to ${body.base_code}; ignoring response`);
      return null;
    }

    const rates = body.rates;
    if (!rates || typeof rates !== 'object') {
      this.logger.warn('FX provider response had no rates');
      return null;
    }

    const perUsd: Record<string, bigint> = {};
    for (const { peg } of this.currencies.all()) {
      const raw = rates[peg];
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        // A partial table is unusable: it would make some pairs quotable and
        // others not, from the same refresh.
        this.logger.warn(`FX provider omitted a usable rate for ${peg}`);
        return null;
      }
      perUsd[peg] = MoneyUtil.rateFromNumber(raw);
    }

    const unix = body.time_last_update_unix;
    const asOf =
      typeof unix === 'number' && Number.isFinite(unix) && unix > 0
        ? new Date(unix * 1000)
        : new Date();

    return { perUsd, asOf, source: 'live' };
  }
}
