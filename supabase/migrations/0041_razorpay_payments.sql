-- Razorpay deposit payments + hold confirmation (Phase 9, Phase 4)
--
-- The webhook is the source of truth; the browser callback is UX only. Provider
-- state lives here (payment_intents / payment_events / refunds), NEVER in
-- reservations.status. Money is integer paise. Idempotency is enforced by database
-- UNIQUE constraints, not application checks. Room charges and the policy/deposit
-- snapshot remain confirm_hold()'s job (Phase 3) — this migration does not duplicate
-- them; confirm_hold() itself is unchanged.

-- ------------------------------------------------------------ payment_intents
-- One row per deposit payment attempt for a reservation. The amount is computed
-- server-side at hold time and is the ONLY authoritative amount for that attempt.
create table if not exists payment_intents (
  id                  uuid primary key default gen_random_uuid(),
  reservation_id      uuid not null references reservations (id) on delete cascade,
  provider            text not null default 'razorpay',
  provider_order_id   text unique,
  provider_payment_id text unique,
  amount_paise        integer not null check (amount_paise > 0),
  -- The deposit percentage used to compute amount_paise at ORDER time, captured so
  -- the reservation snapshot stays consistent with the order even if the live
  -- deposit_config changes during the hold.
  deposit_percent     numeric(5,2) check (deposit_percent is null or (deposit_percent >= 0 and deposit_percent <= 100)),
  currency            text not null default 'INR',
  status              text not null default 'ordered'
                      check (status in ('ordered', 'captured', 'failed')),
  created_at          timestamptz not null default now(),
  captured_at         timestamptz,
  failure_reason      text
);
create index if not exists payment_intents_reservation_idx on payment_intents (reservation_id);

-- -------------------------------------------------------------- payment_events
-- The provider-event dedupe ledger — the same pattern (and reason) as
-- channel_inbox: Razorpay WILL redeliver, and the UNIQUE (provider, event id) is
-- the only reliable stop, not an exists() check.
create table if not exists payment_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'razorpay',
  provider_event_id text not null,
  event_type        text not null,
  payload           jsonb not null default '{}'::jsonb,
  status            text not null default 'pending'
                    check (status in ('pending', 'applied', 'duplicate', 'failed')),
  reservation_id    uuid,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  error             text,
  unique (provider, provider_event_id)
);
create index if not exists payment_events_unresolved_idx
  on payment_events (received_at desc) where status in ('pending', 'failed');

-- --------------------------------------------------------------------- refunds
-- A refund lifecycle. A provider refund API call is NOT a completed refund — the
-- negative folio payment is created only when the provider confirms 'processed'.
create table if not exists refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_intent_id  uuid not null references payment_intents (id) on delete cascade,
  reservation_id     uuid references reservations (id) on delete cascade,
  provider_refund_id text unique,
  amount_paise       integer not null check (amount_paise > 0),
  status             text not null default 'requested'
                     check (status in ('requested', 'processing', 'processed', 'failed')),
  reason             text,
  created_at         timestamptz not null default now(),
  processed_at       timestamptz,
  error              text
);
create index if not exists refunds_reservation_idx on refunds (reservation_id);
create index if not exists refunds_open_idx
  on refunds (created_at desc) where status in ('requested', 'processing', 'failed');

-- One razorpay payments row per provider reference (a payment id, or a refund id):
-- the final DB guard that a captured deposit and a completed refund are each posted
-- to the folio exactly once, even under a replayed webhook.
create unique index if not exists payments_razorpay_reference_idx
  on payments (reference) where method = 'razorpay' and reference is not null;

-- --------------------------------------------------------------------- RLS
alter table payment_intents enable row level security;
alter table payment_events  enable row level security;
alter table refunds         enable row level security;
revoke all on payment_intents from anon, authenticated;
revoke all on payment_events  from anon, authenticated;
revoke all on refunds         from anon, authenticated;

-- ================================================= deposit_for_reservation
-- The authoritative deposit: the stay total priced from the SAME rate calendar
-- confirm_hold()/ensure_room_charges() will bill (cheapest active plan per unit per
-- night), times the active deposit percentage (Phase 2). Integer paise. Read-only —
-- it posts nothing. NO client amount is ever involved.
create or replace function public.deposit_for_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_res     reservations%rowtype;
  v_total   bigint;
  v_missing boolean;
  v_pct     numeric;
  v_min     integer;
  v_deposit integer;
begin
  select * into v_res from reservations where id = p_reservation_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select coalesce(sum(x.p), 0), bool_or(x.p is null)
    into v_total, v_missing
    from (
      select (
        select r.price_paise
          from rates r
          join rate_plans rp on rp.id = r.rate_plan_id
         where r.room_type_id = u.room_type_id
           and r.stay_date = d::date
           and rp.active and not r.closed
         order by rp.min_nights, r.price_paise
         limit 1
      ) as p
      from allocations a
      join units u on u.id = a.unit_id
      cross join generate_series(lower(a.stay), upper(a.stay) - 1, interval '1 day') d
     where a.reservation_id = p_reservation_id and a.reason = 'booking'
    ) x;

  if v_total is null or coalesce(v_missing, true) then
    return jsonb_build_object('ok', false, 'code', 'NO_RATE');
  end if;
  if v_total <= 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_CHARGE');
  end if;

  select dc.percent, dc.min_amount_paise into v_pct, v_min
    from deposit_config dc
   where dc.effective_from <= now() and (dc.effective_to is null or now() < dc.effective_to)
   order by dc.effective_from desc, dc.version desc
   limit 1;
  if v_pct is null then
    return jsonb_build_object('ok', false, 'code', 'NO_DEPOSIT_CONFIG');
  end if;

  v_deposit := public.compute_deposit_paise(v_total::int, v_pct, v_min);
  return jsonb_build_object('ok', true, 'totalPaise', v_total, 'depositPaise', v_deposit,
                            'percent', v_pct, 'currency', 'INR');
end;
$$;

-- =================================================== create_payment_intent
-- Records the order the server just created with Razorpay. amount_paise is the
-- authoritative deposit; provider_order_id is UNIQUE. Records the guest's policy
-- acceptance timestamp on the reservation (the wording/version is snapshotted later
-- by confirm_hold — never trusted from the client).
create or replace function public.create_payment_intent(
  p_reservation_id uuid,
  p_order_id       text,
  p_amount_paise   integer,
  p_deposit_percent numeric,
  p_currency       text default 'INR'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into payment_intents (reservation_id, provider_order_id, amount_paise, deposit_percent, currency, status)
  values (p_reservation_id, p_order_id, p_amount_paise, p_deposit_percent, p_currency, 'ordered')
  returning id into v_id;

  update reservations set policy_accepted_at = coalesce(policy_accepted_at, now())
   where id = p_reservation_id;

  return jsonb_build_object('ok', true, 'paymentIntentId', v_id);
end;
$$;

-- ===================================================== confirm_paid_hold
-- The Phase 4 promotion wrapper around Phase 3's confirm_hold(). It does NOT
-- duplicate confirm_hold's charge/snapshot logic — it only decides, under a row
-- lock, whether the paid reservation can still be confirmed, then delegates:
--   • valid hold                         -> confirm_hold() (cases A/B)
--   • already confirmed                  -> confirm_hold() returns alreadyConfirmed
--   • EXPIRED but still holding its units-> revive the hold (extend expiry) and
--     confirm_hold() — the guest paid and nobody reclaimed the slot (case C)
--   • cancelled / reclaimed / no units   -> INVENTORY_LOST (case D)
-- confirm_hold() itself is unchanged; Phase 3's "an expired hold cannot be
-- confirmed directly" invariant still holds.
create or replace function public.confirm_paid_hold(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res reservations%rowtype;
begin
  select * into v_res from reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'INVENTORY_LOST', 'reason', 'NOT_FOUND');
  end if;

  if v_res.status = 'confirmed' and v_res.policy_version_id is not null then
    return public.confirm_hold(p_reservation_id); -- idempotent alreadyConfirmed
  end if;

  if v_res.status <> 'hold' then
    return jsonb_build_object('ok', false, 'code', 'INVENTORY_LOST', 'reason', v_res.status);
  end if;
  if not exists (select 1 from allocations a
                  where a.reservation_id = p_reservation_id and a.reason = 'booking') then
    return jsonb_build_object('ok', false, 'code', 'INVENTORY_LOST', 'reason', 'NO_INVENTORY');
  end if;

  -- Still a hold that owns its units. If it lapsed but was never reclaimed, the
  -- units are physically still theirs (the reap could not have run without taking
  -- this row's lock, which we now hold) — revive and confirm.
  if v_res.hold_expires_at is not null and v_res.hold_expires_at <= now() then
    update reservations set hold_expires_at = now() + interval '15 minutes'
     where id = p_reservation_id;
  end if;

  return public.confirm_hold(p_reservation_id);
end;
$$;

-- ===================================================== apply_razorpay_capture
-- The one place a captured deposit is applied. Idempotent: the payment_events
-- UNIQUE is the dedupe boundary, and the payments razorpay-reference UNIQUE is the
-- final guard on the folio row. Verifies provider/order/amount/currency against the
-- stored payment_intent — never a client value.
create or replace function public.apply_razorpay_capture(
  p_order_id     text,
  p_payment_id   text,
  p_amount_paise integer,
  p_currency     text,
  p_event_id     text,
  p_payload      jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent   payment_intents%rowtype;
  v_inserted integer;
  v_confirm  jsonb;
  v_folio    uuid;
  v_refund   uuid;
begin
  -- 1. Dedupe the provider event at the DB boundary.
  insert into payment_events (provider, provider_event_id, event_type, payload, status)
  values ('razorpay', p_event_id, 'payment.captured', p_payload, 'pending')
  on conflict (provider, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('ok', true, 'code', 'DUPLICATE');
  end if;

  -- 2. Locate + lock the intent for this order.
  select * into v_intent from payment_intents where provider_order_id = p_order_id for update;
  if not found then
    update payment_events set status = 'failed', processed_at = now(), error = 'order not found'
     where provider = 'razorpay' and provider_event_id = p_event_id;
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_ORDER_MISMATCH');
  end if;

  -- 3. Verify against the stored intent (authoritative), not the client.
  if p_currency is distinct from v_intent.currency then
    update payment_events set status = 'failed', processed_at = now(), error = 'currency mismatch',
           reservation_id = v_intent.reservation_id
     where provider = 'razorpay' and provider_event_id = p_event_id;
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_CURRENCY_MISMATCH');
  end if;
  if p_amount_paise is distinct from v_intent.amount_paise then
    update payment_events set status = 'failed', processed_at = now(), error = 'amount mismatch',
           reservation_id = v_intent.reservation_id
     where provider = 'razorpay' and provider_event_id = p_event_id;
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_AMOUNT_MISMATCH');
  end if;

  -- 4. Idempotent: this intent already captured.
  if v_intent.status = 'captured' then
    update payment_events set status = 'duplicate', processed_at = now(),
           reservation_id = v_intent.reservation_id
     where provider = 'razorpay' and provider_event_id = p_event_id;
    return jsonb_build_object('ok', true, 'code', 'PAYMENT_ALREADY_PROCESSED');
  end if;

  -- 5. Promote (Phase 3 confirm_hold via the paid-hold wrapper) or fall to the seam.
  v_confirm := public.confirm_paid_hold(v_intent.reservation_id);
  update payment_intents set status = 'captured', provider_payment_id = p_payment_id, captured_at = now()
   where id = v_intent.id;

  if (v_confirm ->> 'ok')::boolean then
    -- Record the deposit against the guest's folio (created by confirm_hold).
    v_folio := (v_confirm ->> 'folioId')::uuid;
    if v_folio is null then
      select id into v_folio from folios
       where reservation_id = v_intent.reservation_id order by (status = 'open') desc, created_at limit 1;
    end if;
    insert into payments (folio_id, method, amount_paise, reference)
    values (v_folio, 'razorpay', p_amount_paise, p_payment_id)
    on conflict (reference) where method = 'razorpay' and reference is not null do nothing;

    -- MONEY AUTHORITY (DEFECT-1 fix). confirm_hold() snapshotted the deposit from the
    -- deposit_config live at CONFIRM time; that can differ from what was ordered and
    -- paid if the config or rate calendar changed during the hold. The authoritative
    -- deposit is what the customer actually paid = payment_intents.amount_paise (which
    -- also equals the verified captured amount and the folio payment). Reconcile the
    -- reservation's deposit fields to the order, so:
    --   deposit_amount_paise = intent amount, deposit_percent_snapshot = order percent.
    -- The cancellation-policy snapshot (policy_version_id / policy_text_snapshot /
    -- cancellation_cutoff_at), resolved by the booking time, is left untouched.
    update reservations
       set deposit_amount_paise     = v_intent.amount_paise,
           deposit_percent_snapshot = coalesce(v_intent.deposit_percent, deposit_percent_snapshot)
     where id = v_intent.reservation_id;

    update payment_events set status = 'applied', processed_at = now(),
           reservation_id = v_intent.reservation_id
     where provider = 'razorpay' and provider_event_id = p_event_id;
    perform public.log_event('payment.captured',
      format('Deposit %s captured, %s confirmed',
             to_char(p_amount_paise / 100.0, 'FM₹999999990.00'),
             coalesce((v_confirm ->> 'code'), '')),
      null, 'Razorpay', v_intent.reservation_id, null, v_folio,
      jsonb_build_object('orderId', p_order_id, 'paymentId', p_payment_id, 'amountPaise', p_amount_paise));
    return jsonb_build_object('ok', true, 'code', 'CONFIRMED',
                              'reservationId', v_intent.reservation_id, 'folioId', v_folio);
  end if;

  -- 5b. INVENTORY_LOST: the money is real but the booking cannot be confirmed. Record
  -- the deposit against a folio for the reservation and open a refund (requested).
  update payment_intents set failure_reason = 'INVENTORY_LOST:' || coalesce(v_confirm ->> 'reason', '')
   where id = v_intent.id;

  select id into v_folio from folios
   where reservation_id = v_intent.reservation_id order by (status = 'open') desc, created_at limit 1;
  if v_folio is null then
    insert into folios (reservation_id, status) values (v_intent.reservation_id, 'open')
    returning id into v_folio;
  end if;
  insert into payments (folio_id, method, amount_paise, reference)
  values (v_folio, 'razorpay', p_amount_paise, p_payment_id)
  on conflict (reference) where method = 'razorpay' and reference is not null do nothing;

  insert into refunds (payment_intent_id, reservation_id, amount_paise, status, reason)
  values (v_intent.id, v_intent.reservation_id, p_amount_paise, 'requested', 'inventory_lost')
  returning id into v_refund;

  update payment_events set status = 'applied', processed_at = now(),
         reservation_id = v_intent.reservation_id
   where provider = 'razorpay' and provider_event_id = p_event_id;
  perform public.log_event('payment.inventory_lost',
    format('Deposit %s captured but inventory lost — refund opened',
           to_char(p_amount_paise / 100.0, 'FM₹999999990.00')),
    null, 'Razorpay', v_intent.reservation_id, null, v_folio,
    jsonb_build_object('orderId', p_order_id, 'paymentId', p_payment_id, 'refundId', v_refund));
  return jsonb_build_object('ok', true, 'code', 'INVENTORY_LOST',
                            'reservationId', v_intent.reservation_id,
                            'refundId', v_refund, 'amountPaise', p_amount_paise);
end;
$$;

-- ================================================= refund provider linkage
-- After the route calls Razorpay's refund API, record the provider refund id and
-- move the row to 'processing'. Idempotent on the refund id.
create or replace function public.attach_refund_provider(
  p_refund_id          uuid,
  p_provider_refund_id text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update refunds
     set provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
         status = case when status = 'requested' then 'processing' else status end
   where id = p_refund_id;
$$;

-- ============================================== apply_razorpay_refund_result
-- The refund webhook. A completed ('processed') refund posts the NEGATIVE folio
-- payment exactly once (payment_events dedupe + payments razorpay-reference UNIQUE);
-- a 'failed' refund stays visible in refunds for staff. Never trusts an API 200 —
-- only the provider's confirmation.
create or replace function public.apply_razorpay_refund_result(
  p_provider_refund_id text,
  p_result             text,     -- 'processed' | 'failed'
  p_event_id           text,
  p_payload            jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund   refunds%rowtype;
  v_inserted integer;
  v_folio    uuid;
begin
  insert into payment_events (provider, provider_event_id, event_type, payload, status)
  values ('razorpay', p_event_id, 'refund.' || p_result, p_payload, 'pending')
  on conflict (provider, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('ok', true, 'code', 'DUPLICATE');
  end if;

  select * into v_refund from refunds where provider_refund_id = p_provider_refund_id for update;
  if not found then
    update payment_events set status = 'failed', processed_at = now(), error = 'unknown refund'
     where provider = 'razorpay' and provider_event_id = p_event_id;
    return jsonb_build_object('ok', false, 'code', 'REFUND_NOT_FOUND');
  end if;

  if v_refund.status = 'processed' then
    update payment_events set status = 'duplicate', processed_at = now(),
           reservation_id = v_refund.reservation_id
     where provider = 'razorpay' and provider_event_id = p_event_id;
    return jsonb_build_object('ok', true, 'code', 'REFUND_ALREADY_PROCESSED');
  end if;

  if p_result = 'processed' then
    -- The completed refund becomes a negative payment on the deposit's folio.
    select f.id into v_folio
      from folios f
      join payments p on p.folio_id = f.id
     where f.reservation_id = v_refund.reservation_id and p.method = 'razorpay' and p.amount_paise > 0
     order by p.received_at limit 1;
    if v_folio is not null then
      insert into payments (folio_id, method, amount_paise, reference)
      values (v_folio, 'razorpay', -v_refund.amount_paise, p_provider_refund_id)
      on conflict (reference) where method = 'razorpay' and reference is not null do nothing;
    end if;
    update refunds set status = 'processed', processed_at = now() where id = v_refund.id;
    update payment_events set status = 'applied', processed_at = now(),
           reservation_id = v_refund.reservation_id
     where provider = 'razorpay' and provider_event_id = p_event_id;
    perform public.log_event('refund.processed',
      format('Refund %s completed', to_char(v_refund.amount_paise / 100.0, 'FM₹999999990.00')),
      null, 'Razorpay', v_refund.reservation_id, null, v_folio,
      jsonb_build_object('refundId', p_provider_refund_id));
    return jsonb_build_object('ok', true, 'code', 'REFUND_PROCESSED');
  else
    update refunds set status = 'failed', error = coalesce(p_payload ->> 'error', 'failed') where id = v_refund.id;
    update payment_events set status = 'applied', processed_at = now(),
           reservation_id = v_refund.reservation_id
     where provider = 'razorpay' and provider_event_id = p_event_id;
    perform public.log_event('refund.failed',
      'Refund failed — needs staff attention', null, 'Razorpay',
      v_refund.reservation_id, null, null, jsonb_build_object('refundId', p_provider_refund_id));
    return jsonb_build_object('ok', true, 'code', 'REFUND_FAILED');
  end if;
end;
$$;

-- --------------------------------------------------------------- privileges
-- Every payment function is service-role only (the routes use the admin client);
-- none is anon/authenticated callable.
revoke all on function public.deposit_for_reservation(uuid)             from public, anon, authenticated;
revoke all on function public.create_payment_intent(uuid, text, integer, numeric, text) from public, anon, authenticated;
revoke all on function public.confirm_paid_hold(uuid)                   from public, anon, authenticated;
revoke all on function public.apply_razorpay_capture(text, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.attach_refund_provider(uuid, text)        from public, anon, authenticated;
revoke all on function public.apply_razorpay_refund_result(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.deposit_for_reservation(uuid)             to service_role;
grant execute on function public.create_payment_intent(uuid, text, integer, numeric, text) to service_role;
grant execute on function public.confirm_paid_hold(uuid)                   to service_role;
grant execute on function public.apply_razorpay_capture(text, text, integer, text, text, jsonb) to service_role;
grant execute on function public.attach_refund_provider(uuid, text)        to service_role;
grant execute on function public.apply_razorpay_refund_result(text, text, text, jsonb) to service_role;
