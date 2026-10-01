-- Membership, billing state, and an append-only entry ledger.
--
-- The design decision worth reading: entries are never a counter that gets
-- incremented. They are ledger rows, each carrying the reason it was credited
-- and the event that caused it. A quarterly draw has to be explicable months
-- later to a third party, and a counter cannot explain itself.

create extension if not exists pgcrypto;

create table if not exists members (
  id                        uuid primary key default gen_random_uuid(),
  email                     text        not null unique,
  tier                      text        not null,
  billing_status            text        not null default 'pending',
  vip_early_bird            boolean     not null default false,
  anet_customer_profile_id  text,
  anet_payment_profile_id   text,
  anet_subscription_id      text,
  created_at                timestamptz not null default now(),
  constraint members_tier_chk
    check (tier in ('explorer_monthly','patron_monthly','ambassador_monthly',
                    'explorer_annual','patron_annual','ambassador_annual')),
  constraint members_billing_status_chk
    check (billing_status in ('pending','active','past_due','cancelled'))
);

-- Every notification Authorize.Net sends, stored once, keyed by their own id.
-- The gateway retries on any non-2xx, and retries are not rare: a timeout on
-- our side produces a duplicate delivery of an event we already handled.
create table if not exists webhook_events (
  event_id     text        primary key,
  event_type   text        not null,
  payload      jsonb       not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- Append-only. One row per credit.
--
-- The unique constraint is the entire idempotency mechanism. A replayed
-- webhook carries the same source_event, so the second insert violates the
-- constraint and is discarded by the database. Application code does not have
-- to remember what it has already done, which is the part that goes wrong
-- under concurrency: two workers can both read "not yet credited" before
-- either writes.
create table if not exists entry_ledger (
  id           bigserial   primary key,
  member_id    uuid        not null references members(id) on delete restrict,
  period       text        not null,
  entries      integer     not null,
  reason       text        not null,
  source_event text        not null,
  created_at   timestamptz not null default now(),
  constraint entry_ledger_reason_chk
    check (reason in ('subscription_payment','annual_bonus','vip_multiplier')),
  constraint entry_ledger_entries_chk check (entries > 0),
  constraint entry_ledger_idempotent
    unique (member_id, period, reason, source_event)
);

-- The quarterly export reads by period; the audit view reads by member.
create index if not exists entry_ledger_period_idx on entry_ledger (period);
create index if not exists entry_ledger_member_idx on entry_ledger (member_id, period);

-- VIP Early Bird qualification is a decision, recorded once, not a flag that
-- someone might set twice. The pre-launch list is versioned so that "why was
-- this member matched?" stays answerable after the list is replaced.
create table if not exists vip_decisions (
  member_id      uuid        primary key references members(id) on delete restrict,
  matched        boolean     not null,
  list_version   text        not null,
  decided_at     timestamptz not null default now()
);
