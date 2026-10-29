import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';

/**
 * Boots the real application against the real Postgres and Redis from
 * globalSetup.
 *
 * Deliberately no mocks below the HTTP boundary. The things most worth testing
 * here -- row locking under contention, unique-constraint races, CHECK
 * constraints, `FOR UPDATE` semantics -- do not exist in an in-memory double, so
 * a suite built on one would pass while the real thing was broken.
 *
 * The only seam is the FX provider, which is pointed at an unreachable address
 * so tests never depend on a third party being up and never pay its latency.
 * Rates therefore come from the seeded snapshot, which makes every converted
 * amount deterministic -- and the provider chain itself is covered by unit tests.
 */
export interface Harness {
  app: NestExpressApplication;
  prisma: PrismaClient;
  http: () => request.Agent;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  // Must be set before the module is built, since config is read at construction.
  process.env.FX_PROVIDER_URL = 'http://127.0.0.1:9/unreachable-by-design';
  process.env.FX_PROVIDER_TIMEOUT_MS = '150';
  process.env.FX_CACHE_TTL_SECONDS = '0';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  // Mirrors main.ts, so the suite exercises the same pipeline as production.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  await app.init();

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is not set; globalSetup should have provided it');
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await prisma.$disconnect();
      await app.close();
    },
  };
}

/**
 * Round rates, written straight into the snapshot table.
 *
 * With the live provider unreachable, the chain serves these from its
 * last-known-good tier, which makes every converted amount in the suite exact
 * and readable: 1 USD buys 1600 NGN, 16 GHS, 625 XAF or 0.8 EUR. Real rates
 * would make assertions either approximate or unreadable.
 */
export const TEST_RATES: Readonly<Record<string, string>> = {
  USD: '1',
  NGN: '1600',
  GHS: '16',
  XAF: '625',
  EUR: '0.8',
};

const RATE_SCALE = 10n ** 12n;

function scaleRate(decimal: string): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole + fraction.padEnd(12, '0').slice(0, 12));
}

export async function seedTestRates(prisma: PrismaClient): Promise<void> {
  const fetchedAt = new Date();
  for (const [quote, rate] of Object.entries(TEST_RATES)) {
    const rateScaled = scaleRate(rate);
    await prisma.fxRateSnapshot.upsert({
      where: { base_quote: { base: 'USD', quote } },
      create: { base: 'USD', quote, rateScaled, source: 'test', fetchedAt },
      update: { rateScaled, source: 'test', fetchedAt },
    });
  }
}

/** The scaled A -> B rate the API will derive from TEST_RATES. */
export function expectedRate(fromPeg: string, toPeg: string): bigint {
  const from = scaleRate(TEST_RATES[fromPeg] as string);
  const to = scaleRate(TEST_RATES[toPeg] as string);
  const numerator = to * RATE_SCALE;
  const quotient = numerator / from;
  // Mirrors MoneyUtil.crossRate's half-up rounding.
  return numerator % from === 0n
    ? quotient
    : (numerator % from) * 2n >= from
      ? quotient + 1n
      : quotient;
}

let counter = 0;

/** A contact nothing else in the suite will claim. */
export function uniqueEmail(prefix = 'w'): string {
  counter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${counter}@example.test`;
}

export function uniquePhone(): string {
  counter += 1;
  // E.164 with a fixed country code and a padded unique tail.
  return `+2347${String(process.pid % 100_000).padStart(5, '0')}${String(counter % 10_000).padStart(4, '0')}`;
}

export function uniqueKey(label = 'k'): string {
  counter += 1;
  return `${label}-${process.pid}-${Date.now()}-${counter}`;
}
