import { Global, Module } from '@nestjs/common';

import { CurrencyRegistry } from './currency-registry.service';
import { MoneyService } from './money.service';

/**
 * Global because the currency table is read once at boot and every module that
 * touches an amount needs it. MoneyUtil is deliberately not a provider: it is
 * static, pure and has no dependencies, so injecting it would buy nothing.
 */
@Global()
@Module({
  providers: [CurrencyRegistry, MoneyService],
  exports: [CurrencyRegistry, MoneyService],
})
export class MoneyModule {}
