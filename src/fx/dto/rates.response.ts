import { ApiProperty } from '@nestjs/swagger';

import type { CurrencyCode } from '../../money/currency.types';
import type { RateSourceName } from '../fx.types';

export class RateEntryResponse {
  @ApiProperty({
    description: 'Currency code. The valid set is whatever GET /currencies returns.',
    example: 'cNGN',
  })
  from!: CurrencyCode;

  @ApiProperty({ example: 'USDx' })
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
    description:
      'True only when the live provider could not be reached, so `source` is `stale` or ' +
      '`fallback`. A `cached` rate inside its TTL is the normal operating mode and is not ' +
      'reported as degraded.',
    example: false,
  })
  degraded!: boolean;

  @ApiProperty({ type: [RateEntryResponse] })
  rates!: RateEntryResponse[];
}

export class CurrencyResponse {
  @ApiProperty({ example: 'cXAF' })
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
