import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing on Node's built-in scrypt.
 *
 * scrypt rather than bcrypt or argon2 because both of those are native modules:
 * they need a build toolchain in the Docker image and are a common cause of
 * "works on my machine". scrypt is in the standard library, is memory-hard, and
 * is an accepted password KDF — so the dependency list stays shorter and
 * `docker compose up` stays reliable.
 */
@Injectable()
export class PasswordService {
  private static readonly KEY_LENGTH = 64;
  private static readonly SALT_BYTES = 16;

  async hash(password: string): Promise<{ hash: string; salt: string }> {
    const salt = randomBytes(PasswordService.SALT_BYTES).toString('hex');
    const derived = await scrypt(password, salt, PasswordService.KEY_LENGTH);
    return { hash: derived.toString('hex'), salt };
  }

  /**
   * Compares in constant time.
   *
   * A plain string comparison leaks how many leading bytes matched, which is
   * enough to recover a hash byte by byte given enough attempts.
   */
  async verify(password: string, salt: string, expectedHash: string): Promise<boolean> {
    const derived = await scrypt(password, salt, PasswordService.KEY_LENGTH);
    const expected = Buffer.from(expectedHash, 'hex');

    // timingSafeEqual throws on a length mismatch, which would itself be a
    // signal, so the lengths are checked first.
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  }
}
