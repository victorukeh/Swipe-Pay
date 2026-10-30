import 'reflect-metadata';

import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import helmet from 'helmet';
import { SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import type { EnvSchema } from './config/env.schema';
import { buildOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<EnvSchema, true>);

  // Baseline security headers (HSTS, no-sniff, frame denial, ...) on every
  // response. A JSON API has little use for a CSP of its own, so the default
  // policy set is left as-is rather than tuned.
  app.use(helmet());

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // DTOs declare amounts as strings on purpose; implicit conversion would
      // be a path for a float to sneak into money handling.
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  // Served from the same builder the committed openapi.json is generated from,
  // so the live UI and the checked-in spec cannot describe different APIs.
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    customSiteTitle: 'Operation Borderless API',
  });

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Operation Borderless listening on http://localhost:${port}`);
  logger.log(`API docs at http://localhost:${port}/docs`);
}

void bootstrap();
