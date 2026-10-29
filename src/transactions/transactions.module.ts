import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { FxModule } from '../fx/fx.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OperationRunner } from './operation.runner';

@Module({
  imports: [FxModule, LedgerModule],
  controllers: [OperationsController],
  providers: [OperationsService, OperationRunner, IdempotencyService],
  exports: [OperationsService],
})
export class TransactionsModule {}
