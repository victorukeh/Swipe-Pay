import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TransactionResponse {
  @ApiProperty({ example: '01a186e1-3c21-7a0e-9f22-6b1d2e4a8c90' })
  id!: string;

  @ApiProperty({ enum: ['DEPOSIT', 'SWAP', 'TRANSFER'], example: 'TRANSFER' })
  type!: string;

  @ApiProperty({
    description:
      'DEBIT when this movement left the calling wallet, CREDIT when it arrived. A single ' +
      'transfer therefore reads as sent to one party and received by the other, without being ' +
      'duplicated.',
    enum: ['DEBIT', 'CREDIT'],
    example: 'DEBIT',
  })
  direction!: string;

  @ApiProperty({ example: '01a186de-ebf2-776d-855a-171636dc7355' })
  sourceWalletId!: string;

  @ApiPropertyOptional({ nullable: true, example: '01a186df-7c10-7bb1-9a44-2f8e1c3d5a67' })
  destWalletId!: string | null;

  @ApiProperty({ example: 'USDx' })
  sourceCurrency!: string;

  @ApiProperty({ description: 'Amount debited, as a decimal string.', example: '10.000000' })
  sourceAmount!: string;

  @ApiProperty({ example: 'EURx' })
  destCurrency!: string;

  @ApiProperty({ description: 'Amount credited, as a decimal string.', example: '9.185000' })
  destAmount!: string;

  @ApiProperty({
    description: 'Rate applied, as units of destCurrency per 1 sourceCurrency.',
    example: '0.9185',
  })
  rate!: string;

  @ApiProperty({
    description:
      'Which tier of the FX chain supplied the rate. `pegged` means a same-currency movement, ' +
      'which needs no provider at all.',
    enum: ['LIVE', 'CACHED', 'STALE', 'FALLBACK', 'PEGGED'],
    example: 'LIVE',
  })
  rateSource!: string;

  @ApiProperty({
    description: 'When the applied rate was last refreshed upstream.',
    example: '2026-10-29T08:00:00.000Z',
  })
  rateAsOf!: string;

  @ApiProperty({ example: '2026-10-29T08:09:12.401Z' })
  createdAt!: string;
}
