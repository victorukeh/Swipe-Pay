import {
  createHarness,
  seedTestRates,
  uniqueEmail,
  uniquePhone,
  type Harness,
} from './app-harness';
import { balances, createWallet, data, deposit, errorCode, walletTotal, wrapper } from './helpers';

describe('wallets', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await seedTestRates(h.prisma);
  });

  afterAll(async () => {
    await h.close();
  });

  describe('creation', () => {
    it('registers a wallet from an email, with no token pair, then logs in', async () => {
      const email = uniqueEmail('create');
      const password = 'correct-horse-battery-staple';
      const res = await h.http().post('/v1/auth/register').send({ email, password }).expect(201);

      const body = data<{
        id: string;
        email: string;
        phone: string | null;
        balances: Array<{ currency: string; amount: string }>;
      }>(res);

      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.email).toBe(email);
      expect(body.phone).toBeNull();
      // Registration no longer hands out a session -- the client logs in
      // separately, exactly as it would on any later visit.
      expect(JSON.stringify(body)).not.toContain('token');

      const loginRes = await h.http().post('/v1/auth/tokens').send({ email, password }).expect(201);
      const { accessToken } = data<{ accessToken: string }>(loginRes);

      await h.http().get('/v1/wallets').set('authorization', `Bearer ${accessToken}`).expect(200);
    });

    it('registers a wallet from a mobile number', async () => {
      const phone = uniquePhone();
      const res = await h
        .http()
        .post('/v1/auth/register')
        .send({ phone, password: 'correct-horse-battery-staple' })
        .expect(201);

      expect(data<{ phone: string }>(res).phone).toBe(phone);
      expect(data<{ email: string | null }>(res).email).toBeNull();
    });

    it('holds a balance in every supported currency, starting at zero', async () => {
      const wallet = await createWallet(h, 'zero');
      const held = await balances(h, wallet);

      // cXAF has no subunit, so its zero is "0" rather than "0.00" -- the
      // precision in the response is the currency's own.
      expect(held).toEqual({
        cNGN: '0.00',
        cGHS: '0.00',
        cXAF: '0',
        USDx: '0.000000',
        EURx: '0.000000',
      });
    });

    it('rejects a second wallet for the same email, whatever its case', async () => {
      const email = uniqueEmail('dup');
      await h
        .http()
        .post('/v1/auth/register')
        .send({ email, password: 'correct-horse-battery-staple' })
        .expect(201);

      const res = await h
        .http()
        .post('/v1/auth/register')
        .send({ email: email.toUpperCase(), password: 'another-password-here' })
        .expect(409);

      // Normalisation is what makes the plain unique index sufficient.
      expect(errorCode(res.body)).toBe('WALLET_CONTACT_TAKEN');
    });

    it('rejects a second wallet for the same phone', async () => {
      const phone = uniquePhone();
      await h
        .http()
        .post('/v1/auth/register')
        .send({ phone, password: 'correct-horse-battery-staple' })
        .expect(201);

      const res = await h
        .http()
        .post('/v1/auth/register')
        .send({ phone, password: 'another-password-here' })
        .expect(409);
      expect(errorCode(res.body)).toBe('WALLET_CONTACT_TAKEN');
    });

    it('requires at least one contact', async () => {
      const res = await h
        .http()
        .post('/v1/auth/register')
        .send({ password: 'correct-horse-battery-staple' })
        .expect(400);
      expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['a malformed email', { email: 'not-an-email' }],
      ['a non-E.164 phone', { phone: '08012345678' }],
      ['a short password', { email: 'x@example.test', password: 'short' }],
    ])('rejects %s', async (_label, payload) => {
      const res = await h
        .http()
        .post('/v1/auth/register')
        .send({ password: 'correct-horse-battery-staple', ...payload })
        .expect(400);
      expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
    });

    it('rejects unknown fields rather than ignoring them', async () => {
      // forbidNonWhitelisted: a typo'd field should be an error, not a silent
      // no-op on a money API.
      await h
        .http()
        .post('/v1/auth/register')
        .send({
          email: uniqueEmail('extra'),
          password: 'correct-horse-battery-staple',
          isAdmin: true,
        })
        .expect(400);
    });

    it('never returns the password or its hash', async () => {
      const res = await h
        .http()
        .post('/v1/auth/register')
        .send({ email: uniqueEmail('secret'), password: 'correct-horse-battery-staple' })
        .expect(201);

      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toContain('correct-horse-battery-staple');
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('salt');
    });
  });

  describe('balances and the USD total', () => {
    it('totals mixed balances in USDx', async () => {
      const wallet = await createWallet(h, 'total');

      // At the seeded rates: 1 USD buys 1600 NGN, 16 GHS or 625 XAF.
      await deposit(h, wallet, 'cNGN', '1600.00'); //   1.000000 USDx
      await deposit(h, wallet, 'cGHS', '16.00'); //     1.000000 USDx
      await deposit(h, wallet, 'cXAF', '625'); //       1.000000 USDx
      await deposit(h, wallet, 'USDx', '2.500000'); //  2.500000 USDx

      expect(await walletTotal(h, wallet)).toBe('5.500000');
    });

    it('reports each balance with its own USD equivalent', async () => {
      const wallet = await createWallet(h, 'equiv');
      await deposit(h, wallet, 'cNGN', '3200.00');

      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(200);

      const rows =
        data<
          Array<{ balances: Array<{ currency: string; amount: string; usdEquivalent: string }> }>
        >(res)[0]!.balances;
      const ngn = rows.find((r) => r.currency === 'cNGN');

      expect(ngn?.amount).toBe('3200.00');
      expect(ngn?.usdEquivalent).toBe('2.000000');
    });

    it('publishes the rate freshness used to price the total', async () => {
      const wallet = await createWallet(h, 'fresh');
      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(200);

      const body =
        data<Array<{ ratesSource: string; ratesAsOf: string; totalCurrency: string }>>(res)[0]!;
      // The suite runs with the live provider unreachable, so the snapshot tier
      // serves and says so rather than pretending the rate is live.
      expect(body.ratesSource).toBe('stale');
      expect(body.totalCurrency).toBe('USDx');
      expect(new Date(body.ratesAsOf).getTime()).not.toBeNaN();
    });

    it("returns the caller's wallet as a collection", async () => {
      const wallet = await createWallet(h, 'coll');
      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(200);

      const wallets = data<Array<{ id: string }>>(res);
      expect(Array.isArray(wallets)).toBe(true);
      expect(wallets).toHaveLength(1);
      expect(wallets[0]!.id).toBe(wallet.id);
    });

    it('sets no-store and Vary on an authenticated response', async () => {
      const wallet = await createWallet(h, 'cache');
      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(200);

      // Without Vary: Authorization a shared cache could serve one wallet's
      // balances to another.
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['vary']).toBe('Authorization');
    });

    it('gives every response a correlation id', async () => {
      const res = await h.http().get('/v1/currencies').expect(200);
      expect(res.headers['x-request-id']).toMatch(/.+/);
    });
  });

  /**
   * The envelope is the API's outermost contract, so it is worth asserting
   * directly rather than only through the helper that unwraps it.
   */
  describe('response envelope', () => {
    it('wraps a successful response in exactly the four envelope keys', async () => {
      const wallet = await createWallet(h, 'env');
      const res = await h
        .http()
        .get('/v1/wallets')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .expect(200);

      const body = wrapper(res);
      expect(Object.keys(body).sort()).toEqual([
        'requestCode',
        'requestData',
        'requestMessage',
        'requestSuccessful',
      ]);
      expect(body.requestSuccessful).toBe(true);
      // The status is repeated in the body, so a client holding only the
      // payload can still tell what happened.
      expect(body.requestCode).toBe(200);
      expect(body.requestMessage).toBe('Wallets retrieved');
      expect(Array.isArray(body.requestData)).toBe(true);
    });

    it('reports 201 in the body for a created resource', async () => {
      const res = await h
        .http()
        .post('/v1/auth/register')
        .send({ email: uniqueEmail('env201'), password: 'correct-horse-battery-staple' })
        .expect(201);

      const body = wrapper(res);
      expect(body.requestSuccessful).toBe(true);
      expect(body.requestCode).toBe(201);
      expect(body.requestMessage).toBe('Wallet registered');
    });

    it('wraps public endpoints too', async () => {
      for (const [path, message] of [
        ['/v1/currencies', 'Currencies retrieved'],
        ['/v1/rates', 'Rates retrieved'],
        ['/v1/health', 'Service health'],
      ] as const) {
        const body = wrapper(await h.http().get(path).expect(200));
        expect(body.requestSuccessful).toBe(true);
        expect(body.requestCode).toBe(200);
        expect(body.requestMessage).toBe(message);
        expect(body.requestData).not.toBeUndefined();
      }
    });

    it('envelopes a logout, which therefore returns 200 rather than 204', async () => {
      const wallet = await createWallet(h, 'env204');
      const res = await h
        .http()
        .delete('/v1/auth/tokens')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .send({})
        .expect(200);

      // A 204 has no body to put the envelope in, so the route returns 200 with
      // a null payload instead of breaking the one-shape rule.
      const body = wrapper(res);
      expect(body.requestSuccessful).toBe(true);
      expect(body.requestMessage).toBe('Signed out');
      expect(body.requestData).toBeNull();
    });
  });

  describe('clearing accounts', () => {
    it('does not expose them through the API', async () => {
      // They exist, but a wallet id for one must not be addressable.
      const system = await h.prisma.wallet.findFirst({ where: { isSystem: true } });
      expect(system).not.toBeNull();

      const wallet = await createWallet(h, 'sys');
      const res = await h
        .http()
        .post('/v1/transfers')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', 'to-a-clearing-account')
        .send({ toWalletId: system!.id, currency: 'cNGN', amount: '1.00' })
        .expect(404);

      expect(errorCode(res.body)).toBe('WALLET_NOT_FOUND');
    });
  });
});
