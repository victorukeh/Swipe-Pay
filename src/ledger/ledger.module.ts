import { Module } from '@nestjs/common';

import { LedgerService } from './ledger.service';
import { SystemAccountsService } from './system-accounts.service';

@Module({
  providers: [LedgerService, SystemAccountsService],
  exports: [LedgerService, SystemAccountsService],
})
export class LedgerModule {}
