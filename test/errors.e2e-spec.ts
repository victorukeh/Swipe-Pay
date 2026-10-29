import { hashRequest } from '../src/common/idempotency/request-hash';
import { createHarness, seedTestRates, uniqueKey, type Harness } from './app-harness';
import {
  createWallet,
  data,
  deposit,
  errorCode,
  errorDetails,
  errorRetryable,
  wrapper,
  type Wallet,
} from './helpers';

/**
 * One case per documented error code.
 *
 * The README publishes this taxonomy as part of the API contract, so each code
 * needs a test that actually produces it -- otherwise the table is a claim
 * rather than a guarantee. Every assertion here also checks the envelope shape,
 * because clients branch on `code`, never on the status alone: three different
 * conditions return 422.
 */
describe('error contract', () => {
  let h: Harness;
  let wallet: Wallet;

  beforeAll(async () => {
    h = await createHarness();
    await seedTestRates(h.prisma);
    wallet = await createWallet(h, 'err');
    await deposit(h, wallet, 'cNGN', '100.00');
  });

  afterAll(async () => {
    await h.close();
  });

  const auth = (): [string, string] => ['authorization', `Bearer ${wallet.accessToken}`];

  it('returns one consistent envelope for every failure', async () => {
    const res = await h
      .http()
      .post('/v1/deposits')
      .set(...auth())
      .set('idempotency-key', uniqueKey('envelope'))
      .send({ currency: 'cFAKE', amount: '1.00' })
      .expect(422);

    const body = wrapper(res);

    // Exactly the four envelope keys, in every response the API gives.
    expect(Object.keys(body).sort()).toEqual([
      'requestCode',
      'requestData',
      'requestMessage',
      'requestSuccessful',
    ]);
    expect(body.requestSuccessful).toBe(false);
    // requestCode is the HTTP status; the specific condition is errorCode.
    expect(body.requestCode).toBe(422);
    expect(body.requestMessage).toBe('Unsupported currency');

    const payload = body.requestData as {
      errorCode: string;
      details: Record<string, unknown>;
      requestId: string;
      retryable: boolean;
    };
    expect(payload.errorCode).toBe('UNSUPPORTED_CURRENCY');
    expect(typeof payload.details).toBe('object');
    // The correlation id is echoed in the header too, so a client can quote it.
    expect(payload.requestId).toBe(res.headers['x-request-id']);
    expect(payload.retryable).toBe(false);
  });

  describe('400', () => {
    it('VALIDATION_FAILED', async () => {
      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', uniqueKey('v'))
        .send({ currency: 'cNGN' })
        .expect(400);
      expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
      expect(errorDetails(res.body)['issues']).toBeDefined();
    });

    it('INVALID_AMOUNT', async () => {
      // Passes the DTO pattern but is not a well-formed decimal for MoneyUtil.
      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', uniqueKey('ia'))
        .send({ currency: 'cNGN', amount: '1e5' })
        .expect(400);
      expect(errorCode(res.body)).toBe('VALIDATION_FAILED');
    });

    it('IDEMPOTENCY_KEY_REQUIRED', async () => {
      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .send({ currency: 'cNGN', amount: '1.00' })
        .expect(400);
      expect(errorCode(res.body)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('INVALID_CURSOR', async () => {
      const res = await h
        .http()
        .get('/v1/transactions?cursor=%21%21%21')
        .set(...auth())
        .expect(400);
      expect(errorCode(res.body)).toBe('INVALID_CURSOR');
    });
  });

  describe('401', () => {
    it('UNAUTHENTICATED', async () => {
      const res = await h.http().get('/v1/wallets').expect(401);
      expect(errorCode(res.body)).toBe('UNAUTHENTICATED');
    });

    it('INVALID_CREDENTIALS', async () => {
      const res = await h
        .http()
        .post('/v1/auth/tokens')
        .send({ email: wallet.email, password: 'wrong-password-entirely' })
        .expect(401);
      expect(errorCode(res.body)).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('404', () => {
    it('WALLET_NOT_FOUND', async () => {
      const res = await h
        .http()
        .post('/v1/transfers')
        .set(...auth())
        .set('idempotency-key', uniqueKey('nf'))
        .send({
          toWalletId: '01a186e6-0000-7000-8000-000000000000',
          currency: 'cNGN',
          amount: '1.00',
        })
        .expect(404);
      expect(errorCode(res.body)).toBe('WALLET_NOT_FOUND');
    });

    it('TRANSACTION_NOT_FOUND', async () => {
      const res = await h
        .http()
        .get('/v1/transactions/01a186e6-0000-7000-8000-000000000001')
        .set(...auth())
        .expect(404);
      expect(errorCode(res.body)).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('409', () => {
    it('WALLET_CONTACT_TAKEN', async () => {
      const res = await h
        .http()
        .post('/v1/wallets')
        .send({ email: wallet.email, password: 'correct-horse-battery-staple' })
        .expect(409);
      expect(errorCode(res.body)).toBe('WALLET_CONTACT_TAKEN');
      expect(errorDetails(res.body)['field']).toBe('email');
    });

    it('IDEMPOTENCY_KEY_IN_FLIGHT', async () => {
      /*
       * The in-flight window is a few milliseconds wide, so racing for it makes
       * a flaky test that passes for the wrong reason when it passes at all.
       * The state is created directly instead -- which is also what a crashed
       * instance leaves behind, the case this branch really exists for.
       */
      const key = uniqueKey('inflight');
      const body = { currency: 'cNGN', amount: '3.00' };

      await h.prisma.idempotencyRecord.create({
        data: {
          scope: 'POST /v1/deposits',
          key,
          walletId: wallet.id,
          requestHash: hashRequest(body),
          state: 'IN_FLIGHT',
        },
      });

      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', key)
        .send(body)
        .expect(409);

      expect(errorCode(res.body)).toBe('IDEMPOTENCY_KEY_IN_FLIGHT');
      // Retryable: the original may still land, so the client should come back
      // for the replayed response rather than treat this as final.
      expect(errorRetryable(res.body)).toBe(true);

      // And no second credit happened while it was blocked.
      const credited = await h.prisma.transaction.count({
        where: { sourceWalletId: wallet.id, idempotencyKey: key },
      });
      expect(credited).toBe(0);
    });
  });

  describe('422', () => {
    it('IDEMPOTENCY_KEY_REUSED', async () => {
      const key = uniqueKey('reuse');
      await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', key)
        .send({ currency: 'cNGN', amount: '1.00' })
        .expect(201);

      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', key)
        .send({ currency: 'cNGN', amount: '2.00' })
        .expect(422);
      expect(errorCode(res.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('INSUFFICIENT_FUNDS', async () => {
      const res = await h
        .http()
        .post('/v1/swaps')
        .set(...auth())
        .set('idempotency-key', uniqueKey('if'))
        .send({ fromCurrency: 'USDx', toCurrency: 'cNGN', amount: '1000.000000' })
        .expect(422);
      expect(errorCode(res.body)).toBe('INSUFFICIENT_FUNDS');
      // The figures are published, so a client can show the user the shortfall.
      expect(errorDetails(res.body)).toMatchObject({
        currency: 'USDx',
        requested: '1000.000000',
        available: '0.000000',
      });
    });

    it('UNSUPPORTED_CURRENCY', async () => {
      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', uniqueKey('uc'))
        .send({ currency: 'cFAKE', amount: '1.00' })
        .expect(422);
      expect(errorCode(res.body)).toBe('UNSUPPORTED_CURRENCY');
    });

    it('AMOUNT_PRECISION_EXCEEDED', async () => {
      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', uniqueKey('ape'))
        .send({ currency: 'cXAF', amount: '100.50' })
        .expect(422);
      expect(errorCode(res.body)).toBe('AMOUNT_PRECISION_EXCEEDED');
      // Rejected, not rounded: 100.50 cXAF is simply not a representable amount.
      expect(errorDetails(res.body)).toMatchObject({ currency: 'cXAF', maxDecimals: 0 });
    });

    it('AMOUNT_OUT_OF_RANGE', async () => {
      const res = await h
        .http()
        .post('/v1/deposits')
        .set(...auth())
        .set('idempotency-key', uniqueKey('aoor'))
        .send({ currency: 'USDx', amount: '99999999999999.000000' })
        .expect(422);
      expect(errorCode(res.body)).toBe('AMOUNT_OUT_OF_RANGE');
    });

    it('SAME_CURRENCY_SWAP', async () => {
      const res = await h
        .http()
        .post('/v1/swaps')
        .set(...auth())
        .set('idempotency-key', uniqueKey('scs'))
        .send({ fromCurrency: 'cNGN', toCurrency: 'cNGN', amount: '1.00' })
        .expect(422);
      expect(errorCode(res.body)).toBe('SAME_CURRENCY_SWAP');
    });

    it('SELF_TRANSFER', async () => {
      const res = await h
        .http()
        .post('/v1/transfers')
        .set(...auth())
        .set('idempotency-key', uniqueKey('st'))
        .send({ toWalletId: wallet.id, currency: 'cNGN', amount: '1.00' })
        .expect(422);
      expect(errorCode(res.body)).toBe('SELF_TRANSFER');
    });

    it('AMOUNT_TOO_SMALL_TO_CONVERT', async () => {
      const res = await h
        .http()
        .post('/v1/swaps')
        .set(...auth())
        .set('idempotency-key', uniqueKey('atstc'))
        .send({ fromCurrency: 'cNGN', toCurrency: 'cXAF', amount: '0.01' })
        .expect(422);
      expect(errorCode(res.body)).toBe('AMOUNT_TOO_SMALL_TO_CONVERT');
    });
  });

  describe('403', () => {
    it('FORBIDDEN_WALLET_ACCESS', async () => {
      const other = await createWallet(h, 'err-other');
      const third = await createWallet(h, 'err-third');
      await deposit(h, other, 'cNGN', '10.00');

      const sent = await h
        .http()
        .post('/v1/transfers')
        .set('authorization', `Bearer ${other.accessToken}`)
        .set('idempotency-key', uniqueKey('fwa'))
        .send({ toWalletId: wallet.id, currency: 'cNGN', amount: '1.00' })
        .expect(201);

      const res = await h
        .http()
        .get(`/v1/transactions/${data<{ id: string }>(sent).id}`)
        .set('authorization', `Bearer ${third.accessToken}`)
        .expect(403);
      expect(errorCode(res.body)).toBe('FORBIDDEN_WALLET_ACCESS');
    });
  });

  describe('503', () => {
    it('RATE_UNAVAILABLE when a currency has no quotable peg', async () => {
      /*
       * Every tier of the chain quotes the five seeded pegs, so the only way to
       * reach this code is a currency whose peg nothing can price. Adding one is
       * a realistic scenario -- the currency table is the authority, so an
       * operator can introduce a stablecoin before the rate feed covers it --
       * and the API has to degrade on that pair without affecting the rest.
       */
      await h.prisma.currency.upsert({
        where: { code: 'cZZZ' },
        create: {
          code: 'cZZZ',
          peg: 'ZZZ',
          decimals: 2,
          name: 'Unquotable test coin',
          minorUnit: 'unit',
          sortOrder: '0.95',
        },
        update: { isActive: true },
      });

      // The registry caches at boot, so a fresh app is needed to see it.
      const fresh = await createHarness();
      try {
        const freshWallet = await (async () => {
          const res = await fresh
            .http()
            .post('/v1/wallets')
            .send({
              email: `zzz-${Date.now()}@example.test`,
              password: 'correct-horse-battery-staple',
            })
            .expect(201);
          return data<{ id: string; tokens: { accessToken: string } }>(res);
        })();

        await fresh
          .http()
          .post('/v1/deposits')
          .set('authorization', `Bearer ${freshWallet.tokens.accessToken}`)
          .set('idempotency-key', uniqueKey('zzz-dep'))
          .send({ currency: 'cZZZ', amount: '100.00' })
          .expect(201);

        const res = await fresh
          .http()
          .post('/v1/swaps')
          .set('authorization', `Bearer ${freshWallet.tokens.accessToken}`)
          .set('idempotency-key', uniqueKey('zzz-swap'))
          .send({ fromCurrency: 'cZZZ', toCurrency: 'USDx', amount: '10.00' })
          .expect(503);

        expect(errorCode(res.body)).toBe('RATE_UNAVAILABLE');
        // Transient: the key is released so a retry can work once the feed
        // covers the pair.
        expect(errorRetryable(res.body)).toBe(true);

        // A deposit in the unquotable currency still worked, and pairs that are
        // quotable are unaffected.
        await fresh.http().get('/v1/rates').expect(503);
      } finally {
        await fresh.close();
        // Deactivate rather than delete, so any history stays readable.
        await h.prisma.currency.update({ where: { code: 'cZZZ' }, data: { isActive: false } });
      }
    });
  });
});
