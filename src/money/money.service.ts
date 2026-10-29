import { Injectable } from '@nestjs/common';

import { CurrencyRegistry } from './currency-registry.service';
import type { CurrencyCode, CurrencyMeta } from './currency.types';
import type { ConversionResult } from './money.types';
import { MoneyUtil } from './money.util';

/**
 * The currency-aware face of the money layer.
 *
 * MoneyUtil stays pure arithmetic over a scale, with no idea that a currency
 * table exists — which is what lets it be unit-tested exhaustively without a
 * database. This service is the thin layer that resolves a client-supplied code
 * through CurrencyRegistry and then calls it, so every call site gets the
 * unknown-currency rejection for free instead of each one remembering to check.
 */
@Injectable()
export class MoneyService {
  constructor(private readonly currencies: CurrencyRegistry) {}

  /** Validate a client-supplied code, rejecting unknown or deactivated currencies. */
  currency(code: unknown): CurrencyMeta {
    return this.currencies.require(code);
  }

  /** Parse a decimal string into minor units for a named currency. */
  parse(input: string, code: CurrencyCode): { amount: bigint; currency: CurrencyMeta } {
    const currency = this.currencies.require(code);
    return { amount: MoneyUtil.toMinorUnits(input, currency), currency };
  }

  /** Render minor units as a decimal string, for a code that is already trusted. */
  format(minor: bigint, code: CurrencyCode): string {
    // `find` rather than `require`: history in a deactivated currency must stay
    // readable even though no new money may move in it.
    const currency = this.currencies.find(code) ?? this.currencies.require(code);
    return MoneyUtil.toDecimalString(minor, currency);
  }

  convert(params: {
    amount: bigint;
    from: CurrencyMeta;
    to: CurrencyMeta;
    rateScaled: bigint;
  }): ConversionResult {
    return MoneyUtil.convert(params);
  }

  /** Total a wallet's balances in USD, as the brief requires. */
  totalInUsd(
    balances: ReadonlyArray<{ currency: CurrencyCode; amount: bigint }>,
    rateTo: (from: CurrencyMeta) => bigint,
  ): { amount: bigint; currency: CurrencyMeta } {
    const usd = this.currencies.usd();
    const resolved = balances.flatMap(({ currency, amount }) => {
      const meta = this.currencies.find(currency);
      // A balance in a currency no longer in the table cannot be valued; it is
      // still reported individually, just not folded into the total.
      return meta ? [{ currency: meta, amount }] : [];
    });
    return { amount: MoneyUtil.totalInUsd(resolved, rateTo, usd), currency: usd };
  }
}
