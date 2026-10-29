import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { VersioningType } from '@nestjs/common';

import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';

const OUTPUT = join(__dirname, '..', 'openapi.json');

/**
 * Generates the committed OpenAPI spec, or verifies it is current.
 *
 * `yarn docs:openapi` writes the file; `yarn docs:check` fails if it would
 * change. CI runs the check, so the spec cannot silently drift from the code --
 * a committed spec that is quietly wrong is worse than no committed spec, since
 * a reader has no way to tell.
 *
 * The app is created with `NestFactory.create` but never listens: this only
 * needs the route metadata, not a running server.
 */
async function main(): Promise<void> {
  const check = process.argv.includes('--check');

  // Routes are introspected, nothing is executed, so the app must not reach for
  // real infrastructure.
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:1/unused?schema=public';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:1';
  process.env.JWT_ACCESS_SECRET ??= 'spec-generation-secret-0123456789abcdef';
  process.env.JWT_REFRESH_SECRET ??= 'spec-generation-secret-9876543210fedcba';

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    // onModuleInit hooks would try to reach PostgreSQL; the spec does not need
    // them to have run.
    preview: true,
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const document = buildOpenApiDocument(app);
  const serialised = `${JSON.stringify(document, null, 2)}\n`;
  await app.close();

  if (!check) {
    writeFileSync(OUTPUT, serialised, 'utf8');
    const routes = Object.keys(document.paths ?? {}).length;
    console.log(`openapi: wrote ${routes} paths to openapi.json`);
    return;
  }

  if (!existsSync(OUTPUT)) {
    console.error('openapi: openapi.json is missing. Run `yarn docs:openapi`.');
    process.exitCode = 1;
    return;
  }

  const committed = readFileSync(OUTPUT, 'utf8');
  if (digest(committed) !== digest(serialised)) {
    console.error(
      'openapi: openapi.json is out of date with the code. Run `yarn docs:openapi` and commit the result.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('openapi: openapi.json is up to date');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

void main().catch((error: unknown) => {
  console.error('openapi: generation failed', error);
  process.exitCode = 1;
});
