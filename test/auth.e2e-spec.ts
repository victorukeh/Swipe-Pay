import { JwtService } from '@nestjs/jwt';

import { createHarness, seedTestRates, uniqueEmail, type Harness } from './app-harness';
import { createWallet, errorCode } from './helpers';

const PASSWORD = 'correct-horse-battery-staple';

describe('authentication', () => {
  let h: Harness;
  let jwt: JwtService;

  beforeAll(async () => {
    h = await createHarness();
    await seedTestRates(h.prisma);
    jwt = new JwtService({});
  });

  afterAll(async () => {
    await h.close();
  });

  /** Mints a token the suite needs but the API would never issue. */
  async function forge(
    claims: { sub: string; jti: string; typ: 'access' | 'refresh' },
    secret: string,
    // Seconds only. The JWT types model string durations as a template-literal
    // type ("1h"), so a plain string does not fit the signature.
    expiresIn = 900,
  ): Promise<string> {
    return jwt.signAsync(claims, { secret, expiresIn });
  }

  const accessSecret = (): string => process.env['JWT_ACCESS_SECRET'] as string;
  const refreshSecret = (): string => process.env['JWT_REFRESH_SECRET'] as string;

  describe('login', () => {
    it('exchanges credentials for a token pair', async () => {
      const wallet = await createWallet(h, 'login');
      const res = await h
        .http()
        .post('/v1/auth/tokens')
        .send({ email: wallet.email, password: PASSWORD })
        .expect(201);

      const body = res.body as { walletId: string; accessToken: string; tokenType: string };
      expect(body.walletId).toBe(wallet.id);
      expect(body.tokenType).toBe('Bearer');

      await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${body.accessToken}`)
        .expect(200);
    });

    it('gives the same answer for a wrong password and an unknown contact', async () => {
      const wallet = await createWallet(h, 'oracle');

      const wrongPassword = await h
        .http()
        .post('/v1/auth/tokens')
        .send({ email: wallet.email, password: 'definitely-not-the-password' })
        .expect(401);

      const noSuchWallet = await h
        .http()
        .post('/v1/auth/tokens')
        .send({ email: uniqueEmail('ghost'), password: PASSWORD })
        .expect(401);

      // Any difference here would make this endpoint a wallet-enumeration
      // oracle: an attacker could discover which addresses are registered.
      expect(errorCode(wrongPassword.body)).toBe('INVALID_CREDENTIALS');
      expect(errorCode(noSuchWallet.body)).toBe('INVALID_CREDENTIALS');
      expect(JSON.stringify(wrongPassword.body).replace(/"requestId":"[^"]+"/, '')).toBe(
        JSON.stringify(noSuchWallet.body).replace(/"requestId":"[^"]+"/, ''),
      );
    });

    it('requires a contact', async () => {
      const res = await h.http().post('/v1/auth/tokens').send({ password: PASSWORD }).expect(400);
      expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
    });
  });

  describe('access tokens', () => {
    it('rejects a request with no token', async () => {
      const res = await h.http().get('/v1/wallets').expect(401);
      expect(errorCode(res.body)).toBe('UNAUTHENTICATED');
    });

    it.each([
      ['a missing Bearer prefix', (t: string) => t],
      ['a wrong scheme', (t: string) => `Basic ${t}`],
      ['an empty bearer', () => 'Bearer '],
      ['garbage', () => 'Bearer not-a-jwt'],
    ])('rejects %s', async (_label, build) => {
      const wallet = await createWallet(h, 'hdr');
      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', build(wallet.accessToken))
        .expect(401);
      expect(errorCode(res.body)).toBe('UNAUTHENTICATED');
    });

    it('reports an expired token distinctly, so a client knows to refresh', async () => {
      const wallet = await createWallet(h, 'expired');
      const expired = await forge(
        { sub: wallet.id, jti: 'expired-token', typ: 'access' },
        accessSecret(),
        -30,
      );

      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${expired}`)
        .expect(401);
      expect(errorCode(res.body)).toBe('TOKEN_EXPIRED');
    });

    it('rejects a token signed with a different key', async () => {
      const wallet = await createWallet(h, 'forged');
      const forged = await forge(
        { sub: wallet.id, jti: 'forged', typ: 'access' },
        'an-attackers-secret-0123456789abcdef',
      );

      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${forged}`)
        .expect(401);
      expect(errorCode(res.body)).toBe('UNAUTHENTICATED');
    });

    it('rejects a refresh token used as an access token', async () => {
      const wallet = await createWallet(h, 'wrongtype');
      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.refreshToken}`)
        .expect(401);
      // Separate secrets mean this fails on the signature, before the typ check
      // even runs -- the stronger of the two defences.
      expect(errorCode(res.body)).toBe('UNAUTHENTICATED');
    });

    it('reports the wrong token type when the signature is right but typ is not', async () => {
      const wallet = await createWallet(h, 'typ');
      // Only reachable by forging: the API never issues this combination.
      const mismatched = await forge(
        { sub: wallet.id, jti: 'mismatched', typ: 'access' },
        refreshSecret(),
      );

      const res = await h
        .http()
        .post('/v1/auth/tokens/refresh')
        .send({ refreshToken: mismatched })
        .expect(401);
      expect(errorCode(res.body)).toBe('TOKEN_WRONG_TYPE');
    });
  });

  describe('refresh rotation', () => {
    it('issues a new pair and burns the old refresh token', async () => {
      const wallet = await createWallet(h, 'rotate');

      const rotated = await h
        .http()
        .post('/v1/auth/tokens/refresh')
        .send({ refreshToken: wallet.refreshToken })
        .expect(201);

      const next = (rotated.body as { refreshToken: string }).refreshToken;
      expect(next).not.toBe(wallet.refreshToken);

      // Replaying the original is the signal that a refresh token was captured.
      const replay = await h
        .http()
        .post('/v1/auth/tokens/refresh')
        .send({ refreshToken: wallet.refreshToken })
        .expect(401);
      expect(errorCode(replay.body)).toBe('TOKEN_REVOKED');

      // The new one still works.
      await h.http().post('/v1/auth/tokens/refresh').send({ refreshToken: next }).expect(201);
    });

    it('refuses a refresh token that was never issued', async () => {
      const wallet = await createWallet(h, 'orphan');
      const orphan = await forge(
        { sub: wallet.id, jti: 'never-issued', typ: 'refresh' },
        refreshSecret(),
        3600,
      );

      // Deny by default on the refresh side: a valid signature is not enough,
      // the jti has to be on the allowlist.
      const res = await h
        .http()
        .post('/v1/auth/tokens/refresh')
        .send({ refreshToken: orphan })
        .expect(401);
      expect(errorCode(res.body)).toBe('TOKEN_REVOKED');
    });
  });

  describe('logout', () => {
    it('revokes the presented access token immediately', async () => {
      const wallet = await createWallet(h, 'logout');

      await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(200);

      await h
        .http()
        .delete('/v1/auth/tokens')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .send({})
        .expect(204);

      // A JWT is self-contained, so the only way to invalidate one before it
      // expires is the denylist -- this is what proves it works.
      const after = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(401);
      expect(errorCode(after.body)).toBe('TOKEN_REVOKED');
    });

    it('also revokes the refresh token when one is supplied', async () => {
      const wallet = await createWallet(h, 'logout-both');

      await h
        .http()
        .delete('/v1/auth/tokens')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .send({ refreshToken: wallet.refreshToken })
        .expect(204);

      const res = await h
        .http()
        .post('/v1/auth/tokens/refresh')
        .send({ refreshToken: wallet.refreshToken })
        .expect(401);
      expect(errorCode(res.body)).toBe('TOKEN_REVOKED');
    });

    it('still revokes the access token when the supplied refresh token is garbage', async () => {
      const wallet = await createWallet(h, 'logout-junk');

      await h
        .http()
        .delete('/v1/auth/tokens')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .send({ refreshToken: 'not-a-token' })
        .expect(204);

      // Revoking the access token is the part that matters; a malformed refresh
      // token must not prevent it.
      await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(401);
    });

    it('requires authentication', async () => {
      await h.http().delete('/v1/auth/tokens').send({}).expect(401);
    });
  });

  describe('public routes', () => {
    it.each([['/v1/rates'], ['/v1/currencies'], ['/v1/health']])(
      '%s needs no token',
      async (path) => {
        await h.http().get(path).expect(200);
      },
    );

    it('every money route is closed by default', async () => {
      // Deny-by-default: the guard is global and these opt in to nothing.
      await h.http().post('/v1/deposits').send({ currency: 'cNGN', amount: '1.00' }).expect(401);
      await h.http().post('/v1/swaps').send({}).expect(401);
      await h.http().post('/v1/transfers').send({}).expect(401);
      await h.http().get('/v1/transactions').expect(401);
      await h.http().get('/v1/attempts').expect(401);
      await h.http().get('/v1/wallets').expect(401);
    });
  });
});
