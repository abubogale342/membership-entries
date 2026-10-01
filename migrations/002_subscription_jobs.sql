-- Enrolment cannot be a single synchronous request.
--
-- Authorize.Net's CIM payment profile is not immediately visible to ARB.
-- Creating a profile and immediately starting a subscription against it
-- returns E00040 "The record cannot be found" — the profile exists, ARB just
-- cannot see it yet. Propagation takes somewhere between 15 and 60 seconds,
-- and it is not a documented guarantee, so it cannot be waited out with a
-- fixed sleep.
--
-- So the work is persisted and retried. The member exists the moment their
-- card is tokenised; the subscription arrives shortly afterwards.

create table if not exists subscription_jobs (
  id              bigserial   primary key,
  member_id       uuid        not null unique references members(id) on delete restrict,
  status          text        not null default 'pending',
  attempts        integer     not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint subscription_jobs_status_chk
    check (status in ('pending','running','done','failed'))
);

-- The worker reads by "what is due now", so that is what gets the index.
create index if not exists subscription_jobs_due_idx
  on subscription_jobs (next_attempt_at)
  where status = 'pending';
