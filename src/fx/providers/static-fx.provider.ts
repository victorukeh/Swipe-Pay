import { Injectable } from '@nestjs/common';

import { MoneyUtil } from '../../money/money.util';
import type { FxRateProvider, RateTable } from '../fx.types';

/**
 * The last line of defence: a committed rate table.
 *
 * These are indicative mid-market rates recorded when this service was built.
 * They are certainly out of date, which is exactly why a response served from
 * here is labelled `source: "fallback"` with the original date as `asOf` — a
 * client can see it is being given a stale number and decide what to do. The
 * alternative, failing the request, would mean a third-party outage stops people
 * moving money.
 */
export const STATIC_RATES_AS_OF = new Date('2026-10-01T00:00:00.000Z');

/** Units of each currency per 1 USD. */
export const STATIC_PER_USD: Readonly<Record<string, string>> = {
  USD: '1',
  NGN: '1478.50',
  GHS: '12.15',
  XAF: '563.40',
  EUR: '0.9185',
};

@Injectable()
export class StaticFxProvider implements FxRateProvider {
  readonly name = 'static';

  fetch(): Promise<RateTable | null> {
    return Promise.resolve({
      perUsd: Object.fromEntries(
        Object.entries(STATIC_PER_USD).map(([peg, rate]) => [peg, MoneyUtil.parseRate(rate)]),
      ),
      asOf: STATIC_RATES_AS_OF,
      source: 'fallback',
    });
  }
}
