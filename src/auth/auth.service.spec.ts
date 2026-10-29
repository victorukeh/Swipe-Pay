import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { ErrorCode } from '../common/errors/error-code';
import type { EnvSchema } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import type { TokenStore } from './token.store';

const WALLET_ID = '01a186d3-8580-75db-876b-edb94feb8e0c';
const ACCESS_SECRET = 'test-access-secret-0123456789abcdefghij';
const REFRESH_SECRET = 'test-refresh-secret-0123456789abcdefghij';

/** An in-memory TokenStore — five methods, which is the point of the narrow port. */
function memoryStore(): TokenStore & { refresh: Set<string>; revokedAccess: Set<string> } {
  const refresh = new Set<string>();
  const revokedAccess = new Set<string>();
  return {
    refresh,
    revokedAccess,
    allowRefresh: (jti, walletId) => {
      refresh.add(`${walletId}:${jti}`);
      return Promise.resolve();
    },
    isRefreshAllowed: (jti, walletId) => Promise.resolve(refresh.has(`${walletId}:${jti}`)),
    revokeRefresh: (jti, walletId) => {
      refresh.delete(`${walletId}:${jti}`);
      return Promise.resolve();
    },
    revokeAccess: (jti) => {
      revokedAccess.add(jti);
      return Promise.resolve();
    },
    isAccessRevoked: (jti) => Promise.resolve(revokedAccess.has(jti)),
  };
}

function config(): ConfigService<EnvSchema, true> {
  const values: Record<string, unknown> = {
    JWT_ACCESS_TTL: 900,
    JWT_REFRESH_TTL: 2_592_000,
    JWT_ACCESS_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: REFRESH_SECRET,
    PASSWORD_KEY_LENGTH: 64,
    PASSWORD_SALT_BYTES: 16,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<EnvSchema, true>;
}

interface Fixture {
  auth: AuthService;
  store: ReturnType<typeof memoryStore>;
  passwords: PasswordService;
}

function build(
  wallet?: { id: string; isSystem: boolean; passwordHash: string; salt: string } | null,
): Fixture {
  const store = memoryStore();
  const passwords = new PasswordService(config());
  const prisma = {
    wallet: {
      findFirst: jest.fn().mockResolvedValue(
        wallet
          ? {
              id: wallet.id,
              isSystem: wallet.isSystem,
              credential: { passwordHash: wallet.passwordHash, salt: wallet.salt },
            }
          : null,
      ),
      findUnique: jest
        .fn()
        .mockResolvedValue(wallet ? { id: wallet.id, isSystem: wallet.isSystem } : null),
    },
  } as unknown as PrismaService;

  return {
    auth: new AuthService(prisma, passwords, new JwtService({}), store, config()),
    store,
    passwords,
  };
}

async function walletWithPassword(password: string) {
  const { hash, salt } = await new PasswordService(config()).hash(password);
  return { id: WALLET_ID, isSystem: false, passwordHash: hash, salt };
}

describe('PasswordService', () => {
  const service = new PasswordService(config());

  it('verifies a correct password', async () => {
    const { hash, salt } = await service.hash('correct-horse-battery');
    await expect(service.verify('correct-horse-battery', salt, hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const { hash, salt } = await service.hash('correct-horse-battery');
    await expect(service.verify('wrong-horse-battery', salt, hash)).resolves.toBe(false);
  });

  it('produces a different hash for the same password, so hashes are not a rainbow table', async () => {
    const a = await service.hash('same-password-here');
    const b = await service.hash('same-password-here');
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // timingSafeEqual throws on a length mismatch, which would itself leak.
    await expect(service.verify('password-1234', 'salt', 'abcd')).resolves.toBe(false);
  });
});

describe('AuthService.normaliseContact', () => {
  it('lower-cases and trims an email, satisfying the database CHECK', () => {
    expect(AuthService.normaliseContact({ email: '  Ada@Example.COM ' })).toEqual({
      email: 'ada@example.com',
      phone: null,
    });
  });

  it('requires at least one contact', () => {
    expect(() => AuthService.requireOneContact({})).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }),
    );
    expect(() => AuthService.requireOneContact({ email: '   ' })).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }),
    );
  });
});

describe('AuthService login', () => {
  it('issues a pair for valid credentials', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));

    const pair = await auth.login({ email: 'ada@example.com', password: 'correct-horse-battery' });

    expect(pair.walletId).toBe(WALLET_ID);
    expect(pair.tokenType).toBe('Bearer');
    expect(pair.expiresIn).toBe(900);
    expect(pair.accessToken).not.toBe(pair.refreshToken);
  });

  it('gives the same error for an unknown contact and a wrong password', async () => {
    const existing = build(await walletWithPassword('correct-horse-battery'));
    const missing = build(null);

    const wrongPassword = await existing.auth
      .login({ email: 'ada@example.com', password: 'wrong-horse-battery' })
      .catch((e: unknown) => e);
    const noWallet = await missing.auth
      .login({ email: 'nobody@example.com', password: 'correct-horse-battery' })
      .catch((e: unknown) => e);

    // Identical responses, so the endpoint is not a wallet-enumeration oracle.
    expect((wrongPassword as { code: string }).code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect((noWallet as { code: string }).code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect((wrongPassword as Error).message).toBe((noWallet as Error).message);
  });

  it('allowlists the refresh token it issues', async () => {
    const { auth, store } = build(await walletWithPassword('correct-horse-battery'));
    await auth.login({ email: 'ada@example.com', password: 'correct-horse-battery' });
    expect(store.refresh.size).toBe(1);
  });
});

describe('AuthService token verification', () => {
  it('accepts its own access token', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));
    const pair = await auth.issuePair(WALLET_ID);

    const claims = await auth.verifyAccess(pair.accessToken);
    expect(claims.sub).toBe(WALLET_ID);
    expect(claims.typ).toBe('access');
  });

  it('refuses a refresh token presented as an access token', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));
    const pair = await auth.issuePair(WALLET_ID);

    // Separate secrets mean this fails on the signature before the typ check,
    // which is the stronger of the two defences.
    await expect(auth.verifyAccess(pair.refreshToken)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.UNAUTHENTICATED }),
    );
  });

  it('rejects a token signed with the wrong key', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));
    const forged = await new JwtService({}).signAsync(
      { sub: WALLET_ID, jti: 'forged', typ: 'access' },
      { secret: 'an-attackers-secret-0123456789abcdef', expiresIn: 900 },
    );

    await expect(auth.verifyAccess(forged)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.UNAUTHENTICATED }),
    );
  });

  it('reports an expired token distinctly, so a client knows to refresh', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));
    const expired = await new JwtService({}).signAsync(
      { sub: WALLET_ID, jti: 'old', typ: 'access' },
      { secret: ACCESS_SECRET, expiresIn: -10 },
    );

    await expect(auth.verifyAccess(expired)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.TOKEN_EXPIRED }),
    );
  });

  it('rejects an access token that logout revoked', async () => {
    const { auth, store } = build(await walletWithPassword('correct-horse-battery'));
    const pair = await auth.issuePair(WALLET_ID);
    const claims = await auth.verifyAccess(pair.accessToken);

    await auth.logout({ accessJti: claims.jti, accessExpiresAt: claims.exp, walletId: WALLET_ID });

    expect(store.revokedAccess.has(claims.jti)).toBe(true);
    await expect(auth.verifyAccess(pair.accessToken)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.TOKEN_REVOKED }),
    );
  });
});

describe('AuthService refresh rotation', () => {
  it('issues a new pair and revokes the presented token', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));
    const first = await auth.issuePair(WALLET_ID);

    const second = await auth.refresh(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    // Replaying the original is the signal that a refresh token was stolen.
    await expect(auth.refresh(first.refreshToken)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.TOKEN_REVOKED }),
    );
  });

  it('refuses an access token presented for refresh', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));
    const pair = await auth.issuePair(WALLET_ID);

    await expect(auth.refresh(pair.accessToken)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.UNAUTHENTICATED }),
    );
  });

  it('refuses a refresh token that was never allowlisted', async () => {
    const { auth } = build(await walletWithPassword('correct-horse-battery'));
    const orphan = await new JwtService({}).signAsync(
      { sub: WALLET_ID, jti: 'never-issued', typ: 'refresh' },
      { secret: REFRESH_SECRET, expiresIn: 3600 },
    );

    // Deny-by-default on the refresh side: a valid signature is not enough.
    await expect(auth.refresh(orphan)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.TOKEN_REVOKED }),
    );
  });

  it('revokes the refresh token when logout supplies it', async () => {
    const { auth, store } = build(await walletWithPassword('correct-horse-battery'));
    const pair = await auth.issuePair(WALLET_ID);
    const claims = await auth.verifyAccess(pair.accessToken);

    await auth.logout({
      accessJti: claims.jti,
      accessExpiresAt: claims.exp,
      walletId: WALLET_ID,
      refreshToken: pair.refreshToken,
    });

    expect(store.refresh.size).toBe(0);
    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.TOKEN_REVOKED }),
    );
  });

  it('still revokes the access token when the supplied refresh token is garbage', async () => {
    const { auth, store } = build(await walletWithPassword('correct-horse-battery'));
    const pair = await auth.issuePair(WALLET_ID);
    const claims = await auth.verifyAccess(pair.accessToken);

    await auth.logout({
      accessJti: claims.jti,
      accessExpiresAt: claims.exp,
      walletId: WALLET_ID,
      refreshToken: 'not-a-token',
    });

    // Revoking the access token is the part that matters; a bad refresh token
    // must not prevent it.
    expect(store.revokedAccess.has(claims.jti)).toBe(true);
  });
});
