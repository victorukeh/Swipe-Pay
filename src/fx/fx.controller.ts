import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../auth/public.decorator';
import { CurrencyRegistry } from '../money/currency-registry.service';
import { isDegradedSource } from './fx.degraded';
import { MoneyUtil } from '../money/money.util';
import { CurrencyResponse, RatesResponse } from './dto/rates.response';
import { FxService } from './fx.service';

@ApiTags('rates')
@Controller()
export class FxController {
  constructor(
    private readonly fx: FxService,
    private readonly currencies: CurrencyRegistry,
  ) {}

  @Public()
  @Get('rates')
  @ApiOperation({
    summary: 'Current conversion rates between all supported stablecoins',
    description:
      'Returns every ordered pair, the time the rates were last refreshed, and which tier of the ' +
      'provider chain served them. `degraded: true` means the live provider was unavailable and a ' +
      'cached, stale or static rate was used instead.',
  })
  @ApiOkResponse({ type: RatesResponse })
  @ApiServiceUnavailableResponse({
    description: 'RATE_UNAVAILABLE — every tier of the rate provider chain failed.',
  })
  async rates(): Promise<RatesResponse> {
    const { asOf, source, rates } = await this.fx.getMatrix();
    return {
      asOf: asOf.toISOString(),
      source,
      degraded: isDegradedSource(source),
      rates: rates.map(({ from, to, rate }) => ({ from, to, rate })),
    };
  }

  @Public()
  @Get('currencies')
  @ApiOperation({
    summary: 'Supported stablecoins, their fiat pegs and their precision',
    description:
      'Note cXAF has 0 decimals: the Central African CFA franc has no subunit in circulation, so ' +
      'an amount like "1500.50" is rejected rather than rounded.',
  })
  @ApiOkResponse({ type: [CurrencyResponse] })
  listCurrencies(): CurrencyResponse[] {
    return this.currencies.all().map((meta) => MoneyUtil.describeCurrency(meta));
  }
}
