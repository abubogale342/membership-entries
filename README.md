# membership-entries

Tiered membership billing with an entry ledger that survives redelivery.

Built against the Authorize.Net **sandbox** to work through CIM tokenisation,
recurring billing and webhook handling end to end. It is a working slice, not
a product: six tiers, a subscription per member, an append-only entry ledger,
and a quarterly export for a third-party administrator.

## The problem it exists to solve

A sweepstakes platform credits entries when a subscription payment succeeds.
Authorize.Net retries any notification it does not get a 2xx for, so a timeout
on your side produces a second delivery of an event you already handled. If
entries are a counter you increment, that member now has double entries in a
draw with a holiday attached to it, and nobody finds out until the draw.

The usual fix is "check whether we already credited this, then insert". That
has a race in it. Two workers handling the same redelivery both read *not yet
credited* before either writes.

## What this does instead

Entries are ledger rows, not a counter. Each row carries the reason it was
credited and the event that caused it:

```sql
constraint entry_ledger_idempotent
  unique (member_id, period, reason, source_event)
```

A replayed webhook carries the same `source_event`, so the second insert
violates that constraint and the database discards it. The application does
not have to remember what it has already done, which is the part that fails
under concurrency.

The same shape appears twice more:

- `webhook_events` is keyed on Authorize.Net's own `notificationId`, so a
  redelivery is recorded once and answered with `200 {duplicate:true}`.
  Answering anything else invites the gateway to keep retrying.
- `vip_decisions` records the Early Bird match as a decision, with the version
  of the pre-launch list that produced it. "Why was this member matched?" stays
  answerable after the list is replaced.

## What building it actually taught me

**The SDK hands back an id you cannot send back.**

`createCustomerProfile` succeeds. Reading the new payment profile id out of the
response the documented way:

```js
res.getCustomerPaymentProfileIdList().getNumericString()[0]
```

returns the id **wrapped in literal quote characters** — a nine digit id
arrives as an eleven character string. Store that, send it to
`ARBCreateSubscription`, and the gateway answers:

```
E00003: The 'customerPaymentProfileId' element is invalid - The value
'"937280618"' is invalid according to its datatype 'numericString' -
The Pattern constraint failed.
```

Which is a long way of saying *there are quotation marks in your number*.
`getCustomerProfileId()` on the same response object is clean, so two id
fields from one response have different shapes.

The fix is to stop trusting values at the point they enter the system:

```js
function numericId(value, label) {
  const raw = String(value ?? '').trim().replace(/^"+|"+$/g, '');
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Authorize.Net returned a ${label} that is not numeric: ${JSON.stringify(value)}`);
  }
  return raw;
}
```

An id that is not digits now fails loudly at the boundary instead of becoming
an unreadable schema error two calls and one database round trip later. That
is the same rule the ledger follows, one layer further out.

**CIM accepts a payment profile that ARB cannot use.**

Create a customer payment profile without a billing name and CIM returns
success. Start a subscription against it and ARB answers:

```
E00014: Bill-To First Name is required.
```

The record was accepted by one API and is unusable by another, and you find
out on a later call, against a profile that already exists. There is nothing
at creation time to tell you.

So enrolment requires `billTo.firstName` and `billTo.lastName` and rejects the
request with a 400 if they are missing, rather than tokenising a card and
queueing a subscription that can never succeed. Validate against what the
*next* system needs, not only what the current one accepts.

**Enrolment is two steps, deliberately.**

While chasing the first error I assumed the cause was a known CIM-to-ARB
propagation delay, and restructured enrolment around it: tokenise the card,
persist the member, queue the subscription, retry with backoff. That diagnosis
was wrong — it was the quotes, then the missing billing name.

The structure stayed, for a reason that survives the wrong diagnosis.
Tokenising a card and starting a subscription are two calls to a system you do
not control, with two failure modes, and both of the real errors above landed
on the second one. Had enrolment been a single synchronous request, each would
have surfaced as a customer watching a spinner and then an error page, with a
tokenised card and no subscription left behind and nothing retrying it.

Worth being accurate about what was measured: with a twenty second gap between
tokenisation and the subscription call, every subscription succeeded on the
first attempt. No propagation delay was observed. The queue earns its place by
making the failures recoverable, not by waiting anything out.

```
  subscribed  amelia.vip@example.test   9928409  (attempt 1)
  subscribed  ben.patron@example.test   9928410  (attempt 1)
  subscribed  chidi.annual@example.test 9928411  (attempt 1)
```

The claim is `for update skip locked`, so more than one worker can run without
two of them subscribing the same member.

## Proof

```
npm run test:replay
```

Fires the same signed notification eight times concurrently and asserts the
ledger gained exactly one row:

```
  deliveries sent        8
  processed as new       1
  rejected as duplicate  7
  ledger rows created    1
  entries credited       50

PASS  eight concurrent deliveries, one credit
```

Drop the unique constraint and run it again to see what the database is doing
for you.

## Running it

1. **Sandbox account** — free, no US business or card required, at
   <https://developer.authorize.net/hello_world/sandbox.html>. It gives you an
   API Login ID, a Transaction Key and a Signature Key.
2. **A Postgres** — a free Supabase project is enough. Use the **session
   pooler** string (Dashboard → Connect → Session pooler, port 5432). The
   direct `db.<ref>.supabase.co` host is IPv6-only and fails with
   `ENOTFOUND` on most networks.
3. `cp .env.example .env` and fill it in. `.env` is gitignored.
4. `npm install && npm run migrate`
5. `npm start`, then open <http://localhost:3100>

```
npm test            # unit checks, no database or gateway needed
npm run test:replay # the redelivery proof, needs the database
```

## Design notes

**Gateway calls happen outside the database transaction.** Holding a Postgres
transaction open across a network call to a third party is how connection
pools get exhausted during someone else's outage.

**Signatures are verified against the raw body**, before any JSON parsing.
`JSON.parse` then `JSON.stringify` does not round-trip byte for byte, and the
signature would fail for reasons that look like a gateway bug.

**Card data never reaches this server.** CIM exchanges it for a profile id, so
the PCI scope here is the narrower SAQ A-EP rather than full DSS. Worth
confirming with the acquirer, since high-risk accounts carry extra conditions.

**A misconfigured tier throws.** Crediting zero entries silently is worse than
stopping.

## What this is not

Sandbox only. No production credentials have ever been in this repository. It
has no authentication, no rate limiting and no dunning flow for failed
payments — all of which a real deployment needs, and none of which change the
idempotency argument this exists to demonstrate.
