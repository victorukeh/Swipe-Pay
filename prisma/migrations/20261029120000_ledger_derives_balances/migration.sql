-- ---------------------------------------------------------------------------
-- The ledger becomes the only way money moves.
--
-- Before this migration the application did two writes per leg: it appended a
-- ledger entry and it updated the balance. That meant the balance existed in
-- two places that had to agree, and the agreement held by convention -- there
-- was a test asserting it, which is itself the tell. An `UPDATE balances SET
-- amount = ...` is a destructive write: a bug, or an injected statement, could
-- set a balance to any value at all and leave nothing behind to say so.
--
-- After it, the application can only append to `ledger_entries`. The database
-- derives `balances` from that append and fills in `balance_after` itself. The
-- projection cannot drift, because nothing is able to write it independently.
--
-- What this does and does not protect against, stated plainly: it removes a
-- whole class of application bug and blocks injected DML against either table.
-- It is not a defence against someone who already holds owner or superuser
-- rights on the database -- they can disable a trigger. The production
-- hardening on top is a least-privilege application role:
--
--   REVOKE UPDATE, DELETE ON ledger_entries FROM borderless_app;
--   REVOKE UPDATE          ON balances      FROM borderless_app;
--
-- That is left out of the migration because this sandbox connects as the schema
-- owner, and an owner can re-grant to itself; the triggers below are enforced
-- regardless of which role is connected, so they are the real control here.
-- ---------------------------------------------------------------------------

-- A transaction-local flag. Only the ledger trigger sets it, so it is what
-- distinguishes "the database is maintaining its own projection" from "someone
-- is writing a balance directly".
CREATE OR REPLACE FUNCTION "ledger_write_in_progress"() RETURNS boolean AS $$
BEGIN
  RETURN COALESCE(current_setting('borderless.ledger_write', true), 'off') = 'on';
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------------
-- Appending an entry is what moves money.
--
-- BEFORE INSERT, so the row can carry the balance the database just computed:
-- `balance_after` is then authoritative rather than something the application
-- asserted. The UPDATE ... RETURNING both applies the delta and reads the
-- result in one statement, under the row lock the caller already holds.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "ledger_entries_apply_to_balance"() RETURNS trigger AS $$
DECLARE
  signed_delta BIGINT;
  resulting    BIGINT;
BEGIN
  IF NEW."amount" <= 0 THEN
    RAISE EXCEPTION 'ledger entry amount must be positive, got %', NEW."amount"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- `direction` carries the sign; `amount` is always a magnitude.
  signed_delta := CASE NEW."direction" WHEN 'DEBIT' THEN -NEW."amount" ELSE NEW."amount" END;

  PERFORM set_config('borderless.ledger_write', 'on', true);

  UPDATE "balances"
     SET "amount" = "amount" + signed_delta,
         "updated_at" = now()
   WHERE "wallet_id" = NEW."wallet_id"
     AND "currency"  = NEW."currency"
  RETURNING "amount" INTO resulting;

  PERFORM set_config('borderless.ledger_write', 'off', true);

  IF resulting IS NULL THEN
    -- Balance rows are created before any lock is taken, so this means the
    -- caller skipped that step rather than that the wallet is new.
    RAISE EXCEPTION 'no balance row for wallet % in %; it must exist before the entry is appended',
      NEW."wallet_id", NEW."currency"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Set by the database, not by the caller, so it cannot disagree with the
  -- balance it claims to describe.
  NEW."balance_after" := resulting;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_apply_to_balance"
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_apply_to_balance"();


-- ---------------------------------------------------------------------------
-- The log is append-only, enforced rather than assumed.
--
-- Nothing in the application has any reason to amend history. A correction is a
-- compensating entry, which is an append like any other.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "ledger_entries_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; % is not permitted. Post a compensating entry instead.',
    TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_no_update"
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_reject_mutation"();

CREATE TRIGGER "ledger_entries_no_delete"
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_reject_mutation"();


-- ---------------------------------------------------------------------------
-- A balance may only change as the consequence of an append.
--
-- This is the constraint that answers "what stops the application setting a
-- balance to whatever it likes" -- nothing may touch `amount` except the
-- trigger above. Other columns stay editable, so `allow_negative` can still be
-- administered.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "balances_reject_direct_amount_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."amount" IS DISTINCT FROM OLD."amount" AND NOT "ledger_write_in_progress"() THEN
    RAISE EXCEPTION 'balances.amount is derived from ledger_entries and cannot be set directly (wallet %, %)',
      OLD."wallet_id", OLD."currency"
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Append a ledger entry; the balance follows from it.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "balances_amount_is_derived"
  BEFORE UPDATE ON "balances"
  FOR EACH ROW EXECUTE FUNCTION "balances_reject_direct_amount_change"();


-- A new balance row must start at zero. Otherwise a wallet could be created
-- with a balance that no ledger entry accounts for, which would break the
-- "balance equals the sum of its entries" invariant from the very first row.
CREATE OR REPLACE FUNCTION "balances_must_start_at_zero"() RETURNS trigger AS $$
BEGIN
  IF NEW."amount" <> 0 THEN
    RAISE EXCEPTION 'a new balance row must start at 0; money arrives through ledger_entries'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "balances_start_at_zero"
  BEFORE INSERT ON "balances"
  FOR EACH ROW EXECUTE FUNCTION "balances_must_start_at_zero"();


-- `balance_after` is assigned by the trigger above, so callers must not supply
-- it. A default makes it optional at the ORM layer; the trigger overwrites
-- whatever arrives, so the default value itself is never observable.
ALTER TABLE "ledger_entries" ALTER COLUMN "balance_after" SET DEFAULT 0;
