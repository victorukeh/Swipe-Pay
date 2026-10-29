import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvSchema } from '../config/env.schema';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/**
 * Shortest stored hash treated as a credential rather than corrupt data. Below
 * the configurable floor, so it rejects truncated rows without re-coupling
 * `verify` to the configured length.
 */
const MIN_HASH_BYTES = 32;

@Injectable()
export class PasswordService {
  private readonly keyLength: number;
  private readonly saltBytes: number;

  constructor(config: ConfigService<EnvSchema, true>) {
    this.keyLength = config.get('PASSWORD_KEY_LENGTH', { infer: true });
    this.saltBytes = config.get('PASSWORD_SALT_BYTES', { infer: true });
  }

  async hash(password: string): Promise<{ hash: string; salt: string }> {
    const salt = randomBytes(this.saltBytes).toString('hex');
    const derived = await scrypt(password, salt, this.keyLength);
    return { hash: derived.toString('hex'), salt };
  }

  /**
   * Derives a key and discards it, costing the same as a real {@link verify}.
   *
   * Login calls this when the contact has no credential, so a login for an
   * unknown account takes as long as one for a known account. Without it the
   * response time alone reveals which emails and phone numbers are registered.
   */
  async burnVerifyCost(password: string): Promise<void> {
    const salt = randomBytes(this.saltBytes).toString('hex');
    await scrypt(password, salt, this.keyLength);
  }

  /**
   * The key length comes from the stored hash, not from config, because the
   * stored hash's byte length *is* the length that produced it. That is what
   * lets `PASSWORD_KEY_LENGTH` be changed without invalidating every existing
   * credential: new hashes use the new length, old ones still verify.
   */
  async verify(password: string, salt: string, expectedHash: string): Promise<boolean> {
    const expected = Buffer.from(expectedHash, 'hex');
    if (expected.length < MIN_HASH_BYTES) return false;

    const derived = await scrypt(password, salt, expected.length);
    return timingSafeEqual(derived, expected);
  }
}
