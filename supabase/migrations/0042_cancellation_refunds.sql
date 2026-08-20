-- Guest cancellation, forfeiture & refund accounting (Phase 9, Phase 5)
--
-- Reverse-never-delete: a cancellation posts NEW negative folio lines; the original
-- room_night rows stay visible. Forfeiture posts a cancellation_fee equal to the
-- retained deposit so the folio nets to zero; a refundable cancellation opens the
-- Phase-4 refund lifecycle (the negative payment appears only on refund.processed).
-- Eligibility is read from the reservation SNAPSHOT, never recomputed from current
-- config. Inventory is released immediately. confirm_hold() and 0040/0041 are
-- untouched; payments has no status column; the exclusion constraint is unchanged.

-- --------------------------------------------- folio kinds: reversal + fee
alter table folio_items drop constraint if exists folio_items_kind_check;
alter table folio_items add constraint folio_items_kind_check
  check (kind in ('room_night', 'food', 'beverage', 'extra', 'discount', 'tax',
                  'reversal', 'cancellation_fee'));

-- Idempotency at the DB: one consolidated charge reversal and one cancellation fee
-- per folio. A retried cancellation cannot post either twice.
create unique index if not exists folio_items_one_reversal_per_folio
  on folio_items (folio_id) where kind = 'reversal';
create unique index if not exists folio_items_one_cancellation_fee_per_folio
  on folio_items (folio_id) where kind = 'cancellation_fee';

-- --------------------------------------- terminal reservation status guard
-- Cancelled / checked_out / no_show are terminal. This closes the concurrency race
-- where an unguarded check-in (or any transition) commits after a cancellation and
-- silently overwrites it — a DB-level constraint, not application check-then-act.
create or replace function public.enforce_terminal_status()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('cancelled', 'checked_out', 'no_show')
     and new.status is distinct from old.status then
    raise exception 'reservation % is % and cannot change to %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_terminal_status on reservations;
create trigger reservations_terminal_status
  before update of status on reservations
  for each row execute function public.enforce_terminal_status();

-- ----------------------------------------------- folio accounting helpers
-- One consolidated reversal line = −(Σ room_night on the folio). The original
-- room_night rows are never touched. Idempotent (the partial unique index).
create or replace function public.post_charge_reversal(p_folio_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_charges integer;
begin
  if p_folio_id is null then return 0; end if;
  select coalesce(sum(amount_paise), 0) into v_charges
    from folio_items where folio_id = p_folio_id and kind = 'room_night';
  if v_charges = 0 then return 0; end if;

  insert into folio_items (folio_id, kind, description, qty, unit_price_paise, amount_paise, source)
  values (p_folio_id, 'reversal', 'Cancellation — room charges reversed', 1, -v_charges, -v_charges, 'reception')
  on conflict (folio_id) where kind = 'reversal' do nothing;
  return v_charges;
end;
$$;

create or replace function public.post_cancellation_fee(p_folio_id uuid, p_amount integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_folio_id is null or coalesce(p_amount, 0) <= 0 then return; end if;
  insert into folio_items (folio_id, kind, description, qty, unit_price_paise, amount_paise, source)
  values (p_folio_id, 'cancellation_fee', 'Cancellation fee (retained deposit)', 1, p_amount, p_amount, 'reception')
  on conflict (folio_id) where kind = 'cancellation_fee' do nothing;
end;
$$;

-- ----------------------------------------------------- cancellation preview
-- Server-authoritative decision, read entirely from the reservation snapshot and
-- the immutable policy version. The client never supplies any of these.
create or replace function public.cancellation_preview(p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_res      reservations%rowtype;
  v_deposit  integer;
  v_pct      numeric;
  v_refund   boolean;
  v_refundp  integer;
begin
  select * into v_res from reservations where id = p_reservation_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  v_deposit := v_res.deposit_amount_paise;
  v_pct := coalesce((select refund_percent from cancellation_policies where id = v_res.policy_version_id), 100);
  v_refund := v_deposit is not null and v_res.cancellation_cutoff_at is not null
              and now() < v_res.cancellation_cutoff_at;
  v_refundp := case when v_refund then round(coalesce(v_deposit, 0) * v_pct / 100.0)::int else 0 end;

  return jsonb_build_object(
    'ok', true,
    'status', v_res.status,
    'cancellable', v_res.status in ('confirmed', 'hold'),
    'refundable', v_refund,
    'depositPaise', v_deposit,
    'refundPaise', v_refundp,
    'forfeitPaise', case when v_refund then 0 else coalesce(v_deposit, 0) end,
    'cutoffAt', v_res.cancellation_cutoff_at,
    'policyText', v_res.policy_text_snapshot);
end;
$$;

-- ----------------------------------------- cancel_reservation_with_policy
-- One atomic transaction: eligibility (under a row lock), charge reversal,
-- forfeiture fee OR refund-lifecycle row, allocation release, audit. NO Razorpay
-- HTTP call happens here — the route initiates the provider refund afterward using
-- the returned refundId + paymentId. Not for OTA/channel cancels (see cancel_reservation).
create or replace function public.cancel_reservation_with_policy(
  p_reservation_id uuid,
  p_actor_id       uuid    default null,
  p_actor_label    text    default null,
  p_reason         text    default 'guest',   -- 'guest' | 'staff'
  p_waive_fee      boolean default false,
  p_note           text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res        reservations%rowtype;
  v_folio      uuid;
  v_deposit    integer;
  v_pct        numeric;
  v_refundable boolean;
  v_do_refund  boolean;
  v_refund_id  uuid;
  v_refund_amt integer := 0;
  v_fee        integer := 0;
  v_reversed   integer := 0;
  v_freed      integer;
  v_intent_id  uuid;
  v_payment_id text;
begin
  if p_reason not in ('guest', 'staff') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REASON');
  end if;

  select * into v_res from reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_res.status not in ('confirmed', 'hold') then
    return jsonb_build_object('ok', false, 'code', 'NOT_CANCELLABLE', 'status', v_res.status);
  end if;

  v_deposit := v_res.deposit_amount_paise;
  select id into v_folio from folios
   where reservation_id = p_reservation_id order by (status = 'open') desc, created_at limit 1;

  -- Refundable strictly from the snapshot; a staff waiver returns the deposit too.
  v_pct := coalesce((select refund_percent from cancellation_policies where id = v_res.policy_version_id), 100);
  v_refundable := v_deposit is not null and v_res.cancellation_cutoff_at is not null
                  and now() < v_res.cancellation_cutoff_at;
  v_do_refund  := v_deposit is not null and (v_refundable or p_waive_fee);

  -- Reverse room charges (originals kept). Consolidated line; idempotent.
  if v_folio is not null then
    v_reversed := public.post_charge_reversal(v_folio);
  end if;

  if v_deposit is not null then
    if v_do_refund then
      v_refund_amt := case when p_waive_fee then v_deposit else round(v_deposit * v_pct / 100.0)::int end;
      if v_refund_amt > 0 then
        select id, provider_payment_id into v_intent_id, v_payment_id
          from payment_intents where reservation_id = p_reservation_id and status = 'captured'
          order by captured_at desc limit 1;
        if v_intent_id is not null then
          insert into refunds (payment_intent_id, reservation_id, amount_paise, status, reason)
          values (v_intent_id, p_reservation_id, v_refund_amt, 'requested', p_reason)
          returning id into v_refund_id;
        end if;
      end if;
    else
      -- Forfeiture: fee == retained deposit, folio nets to zero. No refund.
      v_fee := v_deposit;
      if v_folio is not null then perform public.post_cancellation_fee(v_folio, v_fee); end if;
    end if;
  end if;

  -- Release inventory immediately; keep the reservation as history.
  delete from allocations where reservation_id = p_reservation_id;
  get diagnostics v_freed = row_count;
  update reservations set status = 'cancelled', cancellation_reason = p_reason
   where id = p_reservation_id;

  perform public.log_event(
    'reservation.cancelled',
    format('%s cancelled (%s): %s',
           v_res.code,
           case when v_do_refund then 'refundable' else 'forfeited' end,
           case when v_do_refund then to_char(v_refund_amt / 100.0, 'FM₹999999990.00') || ' refund'
                else to_char(v_fee / 100.0, 'FM₹999999990.00') || ' forfeited' end),
    p_actor_id, p_actor_label, p_reservation_id, null, v_folio,
    jsonb_build_object('code', v_res.code, 'reason', p_reason, 'note', p_note,
                       'refundable', v_do_refund, 'refundPaise', v_refund_amt,
                       'forfeitPaise', v_fee, 'reversedPaise', v_reversed,
                       'unitsReleased', v_freed, 'waiveFee', p_waive_fee));

  return jsonb_build_object('ok', true, 'code', 'CANCELLED', 'reservationId', p_reservation_id,
                            'refundable', v_do_refund, 'refundId', v_refund_id,
                            'refundPaise', v_refund_amt, 'forfeitPaise', v_fee,
                            'paymentId', v_payment_id, 'unitsReleased', v_freed);
end;
$$;

-- --------------------------------------------------- staff cancellation
-- Reception uses the same core primitive. A fee waiver requires an explicit reason,
-- is authorized by role, and is audited. The client never chooses a refund amount.
create or replace function public.stays_cancel(
  p_reservation_id uuid,
  p_actor_id       uuid    default null,
  p_actor_label    text    default null,
  p_waive_fee      boolean default false,
  p_note           text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  if p_waive_fee and nullif(btrim(coalesce(p_note, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  end if;
  return public.cancel_reservation_with_policy(
    p_reservation_id, p_actor_id, p_actor_label, 'staff', p_waive_fee, p_note);
end;
$$;

-- ------------------------------------------- guest preview by code + phone
-- Preserves the code+phone boundary (same digit match as public_booking_lookup) and
-- returns the server-computed preview. The reservationId is for the service-role
-- route's internal use; the route never returns it to the browser.
create or replace function public.public_cancellation_preview(p_code text, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     uuid;
  v_digits text;
begin
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(v_digits) < 6 or nullif(btrim(coalesce(p_code, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select res.id into v_id
    from reservations res join guests g on g.id = res.guest_id
   where upper(res.code) = upper(btrim(p_code))
     and right(regexp_replace(coalesce(g.phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10);
  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  return public.cancellation_preview(v_id) || jsonb_build_object('reservationId', v_id, 'code', upper(btrim(p_code)));
end;
$$;

-- ---------------------------------------------------------- no-show (redefine)
-- 0020's stays_mark_no_show, extended: a deposit-bearing no-show gets the SAME
-- forfeiture accounting as a late cancellation (reversal + fee, no refund); a
-- no-deposit no-show keeps the original behaviour. 0020 is not modified.
create or replace function public.stays_mark_no_show(
  p_reservation_id uuid,
  p_actor_id       uuid default null,
  p_actor_label    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res     reservations%rowtype;
  v_freed   integer;
  v_folio   uuid;
  v_fee     integer := 0;
  v_reversed integer := 0;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_res from reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_res.status <> 'confirmed' and v_res.status <> 'hold' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'status', v_res.status);
  end if;

  -- Forfeiture accounting for a paid reservation (same as a late cancellation).
  if v_res.deposit_amount_paise is not null then
    select id into v_folio from folios
     where reservation_id = p_reservation_id order by (status = 'open') desc, created_at limit 1;
    if v_folio is not null then
      v_reversed := public.post_charge_reversal(v_folio);
      v_fee := v_res.deposit_amount_paise;
      perform public.post_cancellation_fee(v_folio, v_fee);
    end if;
  end if;

  delete from allocations where reservation_id = p_reservation_id;
  get diagnostics v_freed = row_count;
  update reservations set status = 'no_show', cancellation_reason = 'no_show'
   where id = p_reservation_id;

  perform public.log_event(
    'guest.no_show',
    format('%s marked no-show, %s unit%s released%s',
           v_res.code, v_freed, case when v_freed = 1 then '' else 's' end,
           case when v_fee > 0 then ', ' || to_char(v_fee / 100.0, 'FM₹999999990.00') || ' forfeited' else '' end),
    p_actor_id, p_actor_label, p_reservation_id, null, v_folio,
    jsonb_build_object('code', v_res.code, 'unitsReleased', v_freed,
                       'forfeitPaise', v_fee, 'reversedPaise', v_reversed));

  return jsonb_build_object('ok', true, 'unitsReleased', v_freed, 'forfeitPaise', v_fee);
end;
$$;

-- --------------------------------------------------------------- privileges
-- The trigger function runs as the table owner; nobody calls it directly. (Default
-- privileges materialise a PUBLIC grant, so revoke it explicitly.)
revoke all on function public.enforce_terminal_status()                from public, anon, authenticated;
revoke all on function public.post_charge_reversal(uuid)               from public, anon, authenticated;
revoke all on function public.post_cancellation_fee(uuid, integer)     from public, anon, authenticated;
revoke all on function public.cancellation_preview(uuid)               from public, anon, authenticated;
revoke all on function public.cancel_reservation_with_policy(uuid, uuid, text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.public_cancellation_preview(text, text)  from public, anon, authenticated;
grant execute on function public.post_charge_reversal(uuid)               to service_role;
grant execute on function public.post_cancellation_fee(uuid, integer)     to service_role;
grant execute on function public.cancellation_preview(uuid)               to service_role, authenticated;
grant execute on function public.cancel_reservation_with_policy(uuid, uuid, text, text, boolean, text) to service_role;
grant execute on function public.public_cancellation_preview(text, text)  to service_role;
-- stays_cancel is reception-facing; stays_mark_no_show keeps its 0020 grant.
revoke all on function public.stays_cancel(uuid, uuid, text, boolean, text) from public, anon;
grant execute on function public.stays_cancel(uuid, uuid, text, boolean, text) to authenticated, service_role;
grant execute on function public.stays_mark_no_show(uuid, uuid, text) to authenticated, service_role;
