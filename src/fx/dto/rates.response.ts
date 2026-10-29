import { ApiProperty } from '@nestjs/swagger';

import { CURRENCY_CODES, type CurrencyCode } from '../../money/currencies';
import type { RateSourceName } from '../fx.types';

export class RateEntryResponse {
  @ApiProperty({ enum: CURRENCY_CODES, example: 'cNGN' })
  from!: CurrencyCode;

  @ApiProperty({ enum: CURRENCY_CODES, example: 'USDx' })
  to!: CurrencyCode;

  @ApiProperty({
    description: 'Units of `to` per 1 unit of `from`, as a decimal string.',
    example: '0.000676',
  })
  rate!: string;
}

export class RatesResponse {
  @ApiProperty({
    description: 'When the underlying rates were last refreshed upstream.',
    example: '2026-10-29T08:00:00.000Z',
  })
  asOf!: string;

  @ApiProperty({
    description: [
      'Where these rates came from, in descending order of freshness:',
      '`live` - just fetched from the provider.',
      '`cached` - a live fetch, served from Redis within its TTL.',
      '`stale` - the provider is unavailable; last-known-good from the database.',
      '`fallback` - the provider is unavailable and no snapshot exists; committed static table.',
    ].join(' '),
    enum: ['live', 'cached', 'stale', 'fallback'],
    example: 'live',
  })
  source!: RateSourceName;

  @ApiProperty({
    description: 'True when `source` is anything other than a current live fetch.',
    example: false,
  })
  degraded!: boolean;

  @ApiProperty({ type: [RateEntryResponse] })
  rates!: RateEntryResponse[];
}

export class CurrencyResponse {
  @ApiProperty({ enum: CURRENCY_CODES, example: 'cXAF' })
  code!: CurrencyCode;

  @ApiProperty({ example: 'Central African CFA franc stablecoin' })
  name!: string;

  @ApiProperty({ description: 'ISO-4217 code of the fiat currency tracked 1:1.', example: 'XAF' })
  peg!: string;

  @ApiProperty({
    description: 'Decimal places this currency admits. An amount with more is rejected.',
    example: 0,
  })
  decimals!: number;

  @ApiProperty({ example: 'franc' })
  minorUnit!: string;

  @ApiProperty({ description: 'Smallest representable amount.', example: '1' })
  smallestAmount!: string;
}
