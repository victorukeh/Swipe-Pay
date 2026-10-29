import { Module } from '@nestjs/common';

import { FxController } from './fx.controller';
import { FxService } from './fx.service';
import { FX_RATE_PROVIDERS, type FxRateProvider } from './fx.types';
import { LiveFxProvider } from './providers/live-fx.provider';
import { SnapshotFxProvider } from './providers/snapshot-fx.provider';
import { StaticFxProvider } from './providers/static-fx.provider';

@Module({
  controllers: [FxController],
  providers: [
    LiveFxProvider,
    SnapshotFxProvider,
    StaticFxProvider,
    {
      /**
       * The order *is* the fallback policy: try live, then the last-known-good
       * snapshot, then the committed static table.
       *
       * FxService receives this as an array behind the FxRateProvider interface
       * and knows nothing about the concrete classes, so changing the policy
       * means editing this list and adding a source means adding a class.
       */
      provide: FX_RATE_PROVIDERS,
      inject: [LiveFxProvider, SnapshotFxProvider, StaticFxProvider],
      useFactory: (
        live: LiveFxProvider,
        snapshot: SnapshotFxProvider,
        fallback: StaticFxProvider,
      ): readonly FxRateProvider[] => [live, snapshot, fallback],
    },
    FxService,
  ],
  exports: [FxService],
})
export class FxModule {}
