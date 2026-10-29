import { Module } from '@nestjs/common';

import { FxModule } from '../fx/fx.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  // FxModule is not global: only the modules that actually price something
  // import it, which keeps the dependency visible rather than ambient.
  imports: [FxModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
