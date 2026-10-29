import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator';
import { ApiEnvelope, ApiEnvelopeError } from '../common/http/response-envelope';
import { ResponseMessage } from '../common/interceptors/response-envelope.interceptor';
import { isDegradedSource } from '../fx/fx.degraded';
import { FxService } from '../fx/fx.service';
import type { RateSourceName } from '../fx/fx.types';
import { CurrencyRegistry } from '../money/currency-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthResponseDto } from './dto/health.response';

type HealthResponse = HealthResponseDto;

/**
 * Liveness and readiness in one endpoint.
 *
 * The distinction that matters here is between *down* and *degraded*. Postgres
 * is load-bearing: without it no money can move, so losing it is `down` and a
 * 503. Redis and the FX provider are not: losing Redis costs the rate cache and
 * token revocation, and losing the provider drops the rate chain to its stale or
 * static tiers -- both of which the API is designed to survive. Reporting those
 * as `down` would make an orchestrator kill a container that is still correctly
 * serving traffic.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly fx: FxService,
    private readonly currencies: CurrencyRegistry,
  ) {}

  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Service health',
    description:
      '`ok` when everything is reachable -- including when rates are being served from the warm ' +
      'cache, which is the normal mode. `degraded` when Redis is down or the FX provider could ' +
      'not be reached and rates have fallen back to a snapshot or the static table; the API ' +
      'still works in that state. `down`, with a 503, only when PostgreSQL is unreachable, since ' +
      'no money can move then.',
  })
  @ApiEnvelope(HealthResponseDto, { description: 'Service is ok or degraded.' })
  @ApiEnvelopeError(503, 'PostgreSQL is unreachable.')
  @ResponseMessage('Service health')
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([this.prisma.isHealthy(), this.redis.isHealthy()]);

    // Goes through the whole chain, so a reachable=true with source "fallback"
    // tells an operator the provider is down but the API is still quoting.
    const fx = await this.fx
      .getTable()
      .then((table) => ({
        reachable: true,
        source: table.source as RateSourceName | null,
        asOf: table.asOf.toISOString(),
        degraded: isDegradedSource(table.source),
      }))
      .catch(() => ({ reachable: false, source: null, asOf: null, degraded: true }));

    const status: HealthResponse['status'] = !database
      ? 'down'
      : redis && fx.reachable && !fx.degraded
        ? 'ok'
        : 'degraded';

    if (status === 'down') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status,
      checks: {
        database,
        redis,
        currencies: this.currencies.all().length,
        fx,
      },
    };
  }
}
