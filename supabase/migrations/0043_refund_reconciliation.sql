-- ============================================================================
-- 0043  Refund reconciliation (Phase 9, Step 5B)
--
-- A refundable cancellation opens a refunds row ('requested') and the app then
-- asks Razorpay to refund OUTSIDE the DB transaction. If that HTTP call fails, or
-- its response is lost after Razorpay already created the refund, the row can be
-- stranded: 'requested' with a NULL provider_refund_id. This migration adds the
-- pieces needed to reconcile such rows SAFELY, without ever violating the money
-- invariants:
--
--   * a negative payment is still posted ONLY on a provider-confirmed 'processed'
--     refund (webhook OR an authenticated reconcile fetch) — never on an API 200;
--   * a lost create-response is recovered by deterministic correlation on OUR
--     refunds.id (carried to Razorpay as the refund `receipt` AND `notes.refund_id`),
--     never by guessing;
--   * a resubmit is idempotent at the provider because `receipt` is Razorpay's
--     per-payment idempotency key (a reuse returns HTTP 400 "Duplicate receipt");
--   * all existing idempotency guarantees are untouched: refunds.provider_refund_id
--     UNIQUE, payment_events UNIQUE(provider,event_id), and the partial-UNIQUE on
--     payments(reference) WHERE method='razorpay' still bound each effect to once.
--
-- Additive only. No change to folio arithmetic, payments structure (no status
-- column), reservation statuses, the allocations exclusion constraint, confirm_hold,
-- the Phase-4 amount invariant, or cancellation eligibility/snapshot semantics.
-- ============================================================================

-- --------------------------------------------------------- reconciliation metadata
-- Operational only — these never influence refund accounting. `attempts` counts how
-- many times the reconciler has SUBMITTED a provider refund for this row; it exists
-- to bound/observe retries. `last_reconciled_at` spaces reconcile passes so a row is
-- not re-examined on every tick.
alter table public.refunds add column if not exists attempts int not null default 0;
alter table public.refunds add column if not exists last_reconciled_at timestamptz;

-- ============================================== apply_razorpay_refund_result (+self-heal)
-- Redefined from 0041 with ONE addition: a deterministic self-heal for the lost
-- create-response case. When the webhook's provider_refund_id matches no local row
-- (because it was never attached), we correlate on the refund entity's notes.refund_id
-- (= our refunds.id) — and only when the row is still open, unbound (or bound to this
-- same provider id), and the amount matches. Anything ambiguous is left observable;
-- we never guess a correlation into existence. Everything downstream is unchanged, so
-- the money still moves exactly once through the same guarded path.
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
  v_refund      refunds%rowtype;
  v_inserted    integer;
  v_folio       uuid;
  v_corr        text;
  v_corr_amount bigint;
begin
  insert into payment_events (provider, provider_event_id, event_type, payload, status)
  values ('razorpay', p_event_id, 'refund.' || p_result, p_payload, 'pending')
  on conflict (provider, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('ok', true, 'code', 'DUPLICATE');
  end if;

  select * into v_refund from refunds where provider_refund_id = p_provider_refund_id for update;

  -- Self-heal: the provider id was never attached locally (lost create-response).
  -- Correlate on OUR refunds.id from the entity notes, deterministically and safely.
  if not found then
    v_corr        := nullif(p_payload #>> '{payload,refund,entity,notes,refund_id}', '');
    v_corr_amount := nullif(p_payload #>> '{payload,refund,entity,amount}', '')::bigint;
    if v_corr is not null and v_corr ~ '^[0-9a-fA-F-]{36}$' then
      select * into v_refund from refunds
       where id = v_corr::uuid
         and status in ('requested', 'processing')
         and (provider_refund_id is null or provider_refund_id = p_provider_refund_id)
         and (v_corr_amount is null or amount_paise = v_corr_amount)
       for update;
      if found then
        update refunds
           set provider_refund_id = p_provider_refund_id,
               status = case when status = 'requested' then 'processing' else status end
         where id = v_refund.id;
      end if;
    end if;
  end if;

  -- No safe correlation: leave the event observable, take no money action.
  if v_refund.id is null then
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

-- ============================================== claim_refunds_for_reconcile
-- Leases a bounded batch of unresolved refunds for one reconcile pass. FOR UPDATE
-- SKIP LOCKED makes two concurrent reconcilers claim DISJOINT sets; stamping
-- last_reconciled_at (and the p_min_age_seconds floor) stops a row being re-claimed
-- on the very next tick. Only 'requested'/'processing' are claimed — 'failed' is a
-- provider-confirmed terminal state that needs a human, not an auto-retry.
create or replace function public.claim_refunds_for_reconcile(
  p_limit           int default 20,
  p_min_age_seconds int default 120
)
returns table (
  refund_id           uuid,
  reservation_id      uuid,
  amount_paise        integer,
  status              text,
  provider_refund_id  text,
  provider_payment_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with claimed as (
    select r.id
      from public.refunds r
     where r.status in ('requested', 'processing')
       and (r.last_reconciled_at is null
            or r.last_reconciled_at < now() - make_interval(secs => greatest(p_min_age_seconds, 0)))
     order by r.created_at
     for update skip locked
     limit greatest(p_limit, 0)
  ),
  bumped as (
    update public.refunds r
       set last_reconciled_at = now()
      from claimed c
     where r.id = c.id
     returning r.id, r.reservation_id, r.amount_paise, r.status, r.provider_refund_id, r.payment_intent_id
  )
  select b.id, b.reservation_id, b.amount_paise, b.status, b.provider_refund_id, pi.provider_payment_id
    from bumped b
    join public.payment_intents pi on pi.id = b.payment_intent_id
   order by b.reservation_id;
end;
$$;

-- ============================================== record_refund_reconcile_attempt
-- Counts one provider-submit attempt by the reconciler. Kept separate from
-- attach_refund_provider so that DISCOVERING an existing provider refund (no new
-- submit) never inflates the attempt count.
create or replace function public.record_refund_reconcile_attempt(p_refund_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.refunds set attempts = attempts + 1 where id = p_refund_id;
$$;

-- --------------------------------------------------------------- privileges
-- Reconciliation is service-role only (the reconcile route uses the admin client);
-- never anon/authenticated. apply_razorpay_refund_result keeps its 0041 grants.
revoke all on function public.claim_refunds_for_reconcile(int, int)      from public, anon, authenticated;
revoke all on function public.record_refund_reconcile_attempt(uuid)      from public, anon, authenticated;
grant execute on function public.claim_refunds_for_reconcile(int, int)   to service_role;
grant execute on function public.record_refund_reconcile_attempt(uuid)   to service_role;
