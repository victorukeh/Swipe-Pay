import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Fail at boot, not at first request. A misconfigured money service that starts
 * successfully is worse than one that refuses to start.
 */
export class EnvSchema {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  API_PREFIX = 'v1';

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  @IsString()
  @MinLength(1)
  REDIS_URL!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' })
  JWT_REFRESH_SECRET!: string;

  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL = 900;

  @IsInt()
  @Min(300)
  JWT_REFRESH_TTL = 2_592_000;

  /**
   * scrypt output length in bytes. Raising it only affects newly written
   * credentials: `PasswordService.verify` takes the length from the stored hash,
   * so existing logins keep working across a change.
   */
  @IsInt()
  @Min(32)
  @Max(256)
  PASSWORD_KEY_LENGTH = 64;

  /** Salt length in bytes for new credentials. 16 is the OWASP floor. */
  @IsInt()
  @Min(16)
  @Max(64)
  PASSWORD_SALT_BYTES = 16;

  @IsOptional()
  @IsString()
  FX_PROVIDER_URL = 'https://open.er-api.com/v6/latest/USD';

  @IsInt()
  @Min(100)
  FX_PROVIDER_TIMEOUT_MS = 4000;

  @IsInt()
  @Min(0)
  FX_CACHE_TTL_SECONDS = 300;

  @IsInt()
  @Min(0)
  FX_SNAPSHOT_MAX_AGE_SECONDS = 86_400;
}

const NUMERIC_KEYS = [
  'PORT',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
  'PASSWORD_KEY_LENGTH',
  'PASSWORD_SALT_BYTES',
  'FX_PROVIDER_TIMEOUT_MS',
  'FX_CACHE_TTL_SECONDS',
  'FX_SNAPSHOT_MAX_AGE_SECONDS',
] as const;

export function validateEnv(raw: Record<string, unknown>): EnvSchema {
  const coerced: Record<string, unknown> = { ...raw };
  for (const key of NUMERIC_KEYS) {
    const value = coerced[key];
    if (typeof value === 'string' && value.trim() !== '') {
      coerced[key] = Number(value);
    } else if (value === '' || value === undefined) {
      delete coerced[key];
    }
  }
  for (const key of Object.keys(coerced)) {
    if (coerced[key] === '') delete coerced[key];
  }

  const config = plainToInstance(EnvSchema, coerced, { exposeDefaultValues: true });
  const errors = validateSync(config, { skipMissingProperties: false, whitelist: false });

  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return config;
}
