import { createHarness, seedTestRates, uniqueKey, type Harness } from './app-harness';
import {
  balances,
  createWallet,
  deposit,
  errorCode,
  swap,
  transfer,
  wrapper,
  type Wallet,
} from './helpers';

describe('money operations', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await seedTestRates(h.prisma);
  });

  afterAll(async () => {
    await h.close();
  });

  describe('deposits', () => {
    it('credits the wallet immediately and records a transaction', async () => {
      const wallet = await createWallet(h, 'dep');
      const body = await deposit(h, wallet, 'cNGN', '1500.75');

      expect(body['type']).toBe('DEPOSIT');
      expect(body['direction']).toBe('CREDIT');
      expect(body['sourceAmount']).toBe('1500.75');
      expect(body['destAmount']).toBe('1500.75');
      // A deposit involves no conversion, so no provider is consulted.
      expect(body['rate']).toBe('1');
      expect(body['rateSource']).toBe('PEGGED');

      expect((await balances(h, wallet))['cNGN']).toBe('1500.75');
    });

    it('accepts a whole-number amount for a currency with no subunit', async () => {
      const wallet = await createWallet(h, 'xaf');
      const body = await deposit(h, wallet, 'cXAF', '2500');

      expect(body['sourceAmount']).toBe('2500');
      expect((await balances(h, wallet))['cXAF']).toBe('2500');
    });

    it('accumulates across deposits', async () => {
      const wallet = await createWallet(h, 'acc');
      await deposit(h, wallet, 'cNGN', '100.01');
      await deposit(h, wallet, 'cNGN', '0.99');

      // Exact integer arithmetic: 100.01 + 0.99 is 101.00, not 100.99999999.
      expect((await balances(h, wallet))['cNGN']).toBe('101.00');
    });

    it('writes balanced double-entry against the mint account', async () => {
      const wallet = await createWallet(h, 'dbl');
      const body = await deposit(h, wallet, 'cNGN', '500.00');

      const entries = await h.prisma.ledgerEntry.findMany({
        where: { transactionId: body['id'] as string },
      });

      expect(entries).toHaveLength(2);
      const net = entries.reduce(
        (sum, e) => sum + (e.direction === 'DEBIT' ? -e.amount : e.amount),
        0n,
      );
      expect(net).toBe(0n);
    });

    it('replays the original response instead of crediting twice', async () => {
      const wallet = await createWallet(h, 'replay');
      const key = uniqueKey('replay');
      const payload = { currency: 'cNGN', amount: '250.00' };

      const first = await h
        .http()
        .post('/v1/deposits')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);
      expect(first.headers['idempotency-replayed']).toBe('false');

      const second = await h
        .http()
        .post('/v1/deposits')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);
      expect(second.headers['idempotency-replayed']).toBe('true');

      // The second response is byte-identical to the first, not merely
      // equivalent -- same transaction id, same timestamp, nothing recomputed.
      expect(wrapper(second)).toEqual(wrapper(first));

      // The decisive assertion: credited once, whatever the client does.
      expect((await balances(h, wallet))['cNGN']).toBe('250.00');
      expect(await h.prisma.transaction.count({ where: { sourceWalletId: wallet.id } })).toBe(1);
    });
  });

  describe('swaps', () => {
    it('converts at the current rate and credits the destination', async () => {
      const wallet = await createWallet(h, 'swap');
      await deposit(h, wallet, 'cNGN', '3200.00');

      const body = await swap(h, wallet, 'cNGN', 'USDx', '1600.00');

      // 1 USD buys 1600 NGN at the seeded rate.
      expect(body['sourceAmount']).toBe('1600.00');
      expect(body['destAmount']).toBe('1.000000');
      expect(body['rate']).toBe('0.000625');

      const held = await balances(h, wallet);
      expect(held['cNGN']).toBe('1600.00');
      expect(held['USDx']).toBe('1.000000');
    });

    it('floors the credit, so value is never created', async () => {
      const wallet = await createWallet(h, 'floor');
      await deposit(h, wallet, 'cNGN', '1000.00');

      // 1000 NGN is 1.5625 XAF-worth... 1000/1600*625 = 390.625 cXAF exactly,
      // and cXAF has no subunit, so the credit floors to 390.
      const body = await swap(h, wallet, 'cNGN', 'cXAF', '1000.00');

      expect(body['destAmount']).toBe('390');
      expect((await balances(h, wallet))['cXAF']).toBe('390');
    });

    it('keeps the dust on the clearing account rather than losing it', async () => {
      const fx = await h.prisma.wallet.findUniqueOrThrow({ where: { systemKey: 'SYSTEM_FX' } });
      const before = await h.prisma.balance.findMany({ where: { walletId: fx.id } });
      const beforeByCurrency = new Map(before.map((b) => [b.currency, b.amount]));

      const wallet = await createWallet(h, 'dust');
      await deposit(h, wallet, 'cNGN', '1000.00');
      await swap(h, wallet, 'cNGN', 'cXAF', '1000.00');

      const after = await h.prisma.balance.findMany({ where: { walletId: fx.id } });
      const afterByCurrency = new Map(after.map((b) => [b.currency, b.amount]));

      // It received 1000.00 cNGN and paid out only 390 cXAF of the 390.625 due.
      expect((afterByCurrency.get('cNGN') ?? 0n) - (beforeByCurrency.get('cNGN') ?? 0n)).toBe(
        100_000n,
      );
      expect((afterByCurrency.get('cXAF') ?? 0n) - (beforeByCurrency.get('cXAF') ?? 0n)).toBe(
        -390n,
      );
    });

    it('writes four legs for a cross-currency movement', async () => {
      const wallet = await createWallet(h, 'legs');
      await deposit(h, wallet, 'cNGN', '1600.00');
      const body = await swap(h, wallet, 'cNGN', 'USDx', '1600.00');

      const entries = await h.prisma.ledgerEntry.findMany({
        where: { transactionId: body['id'] as string },
      });

      // Two currencies, each balancing independently through SYSTEM_FX.
      expect(entries).toHaveLength(4);
      for (const currency of ['cNGN', 'USDx']) {
        const net = entries
          .filter((e) => e.currency === currency)
          .reduce((sum, e) => sum + (e.direction === 'DEBIT' ? -e.amount : e.amount), 0n);
        expect(net).toBe(0n);
      }
    });

    it('rejects a swap larger than the balance, leaving it untouched', async () => {
      const wallet = await createWallet(h, 'poor');
      await deposit(h, wallet, 'cNGN', '10.00');

      const res = await h
        .http()
        .post('/v1/swaps')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', uniqueKey('poor'))
        .send({ fromCurrency: 'cNGN', toCurrency: 'USDx', amount: '1000.00' })
        .expect(422);

      expect(errorCode(res.body)).toBe('INSUFFICIENT_FUNDS');

      const held = await balances(h, wallet);
      expect(held['cNGN']).toBe('10.00');
      expect(held['USDx']).toBe('0.000000');
    });

    it('rejects an amount that would convert to nothing', async () => {
      const wallet = await createWallet(h, 'tiny');
      await deposit(h, wallet, 'cNGN', '10.00');

      // 0.01 NGN is far below one whole XAF franc. Debiting the source and
      // crediting zero would destroy value, so it is refused.
      const res = await h
        .http()
        .post('/v1/swaps')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', uniqueKey('tiny'))
        .send({ fromCurrency: 'cNGN', toCurrency: 'cXAF', amount: '0.01' })
        .expect(422);

      expect(errorCode(res.body)).toBe('AMOUNT_TOO_SMALL_TO_CONVERT');
      expect((await balances(h, wallet))['cNGN']).toBe('10.00');
    });
  });

  describe('transfers', () => {
    let alice: Wallet;
    let bob: Wallet;

    beforeEach(async () => {
      alice = await createWallet(h, 'alice');
      bob = await createWallet(h, 'bob');
    });

    it('moves funds in the same currency', async () => {
      await deposit(h, alice, 'cNGN', '500.00');
      const body = await transfer(h, alice, bob.id, 'cNGN', '120.50');

      expect(body['sourceAmount']).toBe('120.50');
      expect(body['destAmount']).toBe('120.50');
      // Same currency needs no provider at all, which is what keeps these
      // working during an FX outage.
      expect(body['rateSource']).toBe('PEGGED');

      expect((await balances(h, alice))['cNGN']).toBe('379.50');
      expect((await balances(h, bob))['cNGN']).toBe('120.50');
    });

    it('converts automatically when the currencies differ', async () => {
      await deposit(h, alice, 'USDx', '10.000000');
      const body = await transfer(h, alice, bob.id, 'USDx', '10.000000', 'EURx');

      // 1 USD buys 0.8 EUR at the seeded rate.
      expect(body['sourceAmount']).toBe('10.000000');
      expect(body['sourceCurrency']).toBe('USDx');
      expect(body['destAmount']).toBe('8.000000');
      expect(body['destCurrency']).toBe('EURx');
      expect(body['rate']).toBe('0.8');

      expect((await balances(h, alice))['USDx']).toBe('0.000000');
      expect((await balances(h, bob))['EURx']).toBe('8.000000');
    });

    it('records everything the brief requires of a transfer', async () => {
      await deposit(h, alice, 'USDx', '5.000000');
      const body = await transfer(h, alice, bob.id, 'USDx', '5.000000', 'cXAF');

      const row = await h.prisma.transaction.findUniqueOrThrow({
        where: { id: body['id'] as string },
      });

      expect(row.sourceWalletId).toBe(alice.id); // sender
      expect(row.destWalletId).toBe(bob.id); //     receiver
      expect(row.sourceCurrency).toBe('USDx'); //   source currency
      expect(row.sourceAmount).toBe(5_000_000n); // source amount
      expect(row.destCurrency).toBe('cXAF'); //     destination currency
      expect(row.destAmount).toBe(3125n); //        destination amount (5 x 625)
      expect(row.rateScaled).toBe(625n * 10n ** 12n); // the rate applied
      expect(row.createdAt).toBeInstanceOf(Date); //   a timestamp
    });

    it('refuses a transfer to the sending wallet', async () => {
      await deposit(h, alice, 'cNGN', '50.00');
      const res = await h
        .http()
        .post('/v1/transfers')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .set('idempotency-key', uniqueKey('self'))
        .send({ toWalletId: alice.id, currency: 'cNGN', amount: '10.00' })
        .expect(422);

      expect(errorCode(res.body)).toBe('SELF_TRANSFER');
      expect((await balances(h, alice))['cNGN']).toBe('50.00');
    });

    it('refuses a transfer to a wallet that does not exist', async () => {
      await deposit(h, alice, 'cNGN', '50.00');
      const res = await h
        .http()
        .post('/v1/transfers')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .set('idempotency-key', uniqueKey('ghost'))
        .send({
          toWalletId: '01a186e6-0000-7000-8000-000000000000',
          currency: 'cNGN',
          amount: '10.00',
        })
        .expect(404);

      expect(errorCode(res.body)).toBe('WALLET_NOT_FOUND');
      expect((await balances(h, alice))['cNGN']).toBe('50.00');
    });

    it('leaves both balances untouched when the sender cannot cover it', async () => {
      await deposit(h, alice, 'cNGN', '5.00');
      await deposit(h, bob, 'cNGN', '7.00');

      await h
        .http()
        .post('/v1/transfers')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .set('idempotency-key', uniqueKey('over'))
        .send({ toWalletId: bob.id, currency: 'cNGN', amount: '100.00' })
        .expect(422);

      // The debit is applied first inside the transaction; the rollback must
      // leave both sides exactly as they were.
      expect((await balances(h, alice))['cNGN']).toBe('5.00');
      expect((await balances(h, bob))['cNGN']).toBe('7.00');

      const entries = await h.prisma.ledgerEntry.count({ where: { walletId: alice.id } });
      expect(entries).toBe(1); // the deposit only
    });
  });
});
