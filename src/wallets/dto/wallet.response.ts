import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BalanceResponse {
  @ApiProperty({ example: 'cNGN' })
  currency!: string;

  @ApiProperty({
    description:
      'Balance as a decimal string at the currency precision. A string, not a number, because ' +
      'JSON numbers are IEEE-754 doubles and would corrupt the value before a client could read it.',
    example: '125000.00',
  })
  amount!: string;

  @ApiProperty({ description: 'Equivalent in USDx at the current rate.', example: '84.521000' })
  usdEquivalent!: string;
}

export class WalletResponse {
  @ApiProperty({ example: '01a186d3-8580-75db-876b-edb94feb8e0c' })
  id!: string;

  @ApiPropertyOptional({ example: 'ada@example.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: '+2348012345678', nullable: true })
  phone!: string | null;

  @ApiProperty({ example: '2026-10-29T08:09:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    description: 'One entry per supported currency, including zero balances.',
    type: [BalanceResponse],
  })
  balances!: BalanceResponse[];

  @ApiProperty({
    description:
      'Total value of every balance, in USDx. Each leg is floored independently, so the total is ' +
      'never reported higher than its true value.',
    example: '84.521000',
  })
  totalUsdEquivalent!: string;

  @ApiProperty({ description: 'The currency the total is denominated in.', example: 'USDx' })
  totalCurrency!: string;

  @ApiProperty({
    description: 'When the rates used for the USD conversions were last refreshed upstream.',
    example: '2026-10-29T08:00:00.000Z',
  })
  ratesAsOf!: string;

  @ApiProperty({
    description:
      'Which tier of the FX chain priced this response. Anything other than `live` means the ' +
      'live provider was unavailable and a cached, stale or static rate was used.',
    enum: ['live', 'cached', 'stale', 'fallback', 'pegged'],
    example: 'live',
  })
  ratesSource!: string;
}
