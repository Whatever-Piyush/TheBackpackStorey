-- Inbound channel reservations: fix the guard (ROADMAP §4, review item 4)
--
-- ⚠️ This migration must ship together with the webhook hardening in
-- src/app/api/channel/webhook/route.ts. Read that file before deploying this one.
--
-- The old guard was:
--
--     if coalesce(public.user_role(), '') not in ('owner','manager','reception')
--
-- user_role() resolves the caller through auth.uid(). The webhook path runs under
-- the service-role client, which carries no JWT, so auth.uid() is NULL,
-- user_role() is NULL, and the guard raised for EVERY inbound reservation.
-- Verified directly: `user_role() under service_role = [NULL]`.
--
-- Two consequences, and the second is why this is delicate:
--
--   1. Every Channel Manager reservation would have 422'd in production.
--   2. That broken guard is currently the ONLY thing preventing unauthenticated
--      reservation injection, because MockProvider.verify() returns true when its
--      secret is unset. Fixing this alone would open that hole — which is why the
--      webhook is hardened in the same commit.
--
-- NOT fixed by widening the role check to include more roles — that would be a
-- hole, not a fix. It gates on whether an end-user session exists at all.
--
-- Two primitives were tried and rejected, both proven wrong against this schema:
--
--   session_user  — on Supabase, PostgREST logs in as `authenticator` and then
--                   issues SET LOCAL ROLE, so this is 'authenticator' for anon,
--                   authenticated and service_role alike.
--   current_user  — inside a SECURITY DEFINER function this is the function's
--                   OWNER, i.e. 'postgres', regardless of caller. A guard on it
--                   permits everybody. Caught by the authorization matrix test,
--                   which is why that test exists.
--
-- auth.uid() reads the JWT subject and is unaffected by SECURITY DEFINER.

-- The signature changes (p_source is added), and a new signature is a new object
-- with a fresh default PUBLIC grant — the exact trap that produced the 0028
-- finding. The old one is dropped so no overload survives carrying the old guard,
-- and the new one's grants are set explicitly below.
drop function if exists public.create_channel_reservation(
  text, text, text, date, date, uuid, integer, text, integer, uuid, text);

create or replace function public.create_channel_reservation(
  p_channel       text,
  p_guest_name    text,
  p_phone         text,
  p_checkin       date,
  p_checkout      date,
  p_room_type_id  uuid,
  p_units         integer,
  p_external_ref  text,
  p_amount_paise  integer,
  -- Who initiated this. Deliberately has NO default: an audit field that can be
  -- omitted is an audit field that will be omitted.
  p_source        text,
  p_actor_id      uuid default null,
  p_actor_label   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel     record;
  v_type        record;
  v_res         jsonb;
  v_id          uuid;
  v_code        text;
  v_folio       uuid;
  v_name        text;
  v_ref         text;
  v_nights      integer;
  v_actor_label text;
begin
  -- ------------------------------------------------------------------ guard
  --
  -- p_source is cross-checked against the caller's actual role rather than
  -- trusted. A staff session cannot claim to be a webhook, and a webhook cannot
  -- claim to be reception, so the audit trail means something.
  if p_source not in ('webhook', 'reception') then
    return jsonb_build_object('ok', false, 'code', 'BAD_SOURCE');
  end if;

  if p_source = 'webhook' then
    -- Machine callers only: no end-user session. The request's authenticity was
    -- established by the provider's signature check before this was reached.
    --
    -- NOT current_user, and NOT session_user. Inside a SECURITY DEFINER function
    -- current_user is the function's OWNER (postgres), so it is 'postgres' no
    -- matter who called — a check on it silently permits everyone. And on
    -- Supabase, PostgREST logs in as `authenticator` and then SET ROLEs, so
    -- session_user is 'authenticator' for anon, authenticated and service_role
    -- alike. Both were tried; both were wrong.
    --
    -- auth.uid() reads the JWT subject, which SECURITY DEFINER does not touch.
    -- The service-role client carries no JWT, so it is null; a browser session
    -- always has one. anon cannot reach this function at all — no EXECUTE grant.
    if auth.uid() is not null then
      raise exception 'not permitted' using errcode = 'insufficient_privilege';
    end if;
  else
    -- A real person at the desk typing in an OTA email.
    if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
      raise exception 'not permitted' using errcode = 'insufficient_privilege';
    end if;
  end if;

  v_actor_label := coalesce(
    nullif(btrim(coalesce(p_actor_label, '')), ''),
    case p_source when 'webhook' then 'Channel webhook' else 'Reception' end);

  -- ------------------------------------------------------- unchanged from here
  select * into v_channel from channels where code = p_channel and active;
  if v_channel is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_CHANNEL');
  end if;

  v_name := nullif(btrim(coalesce(p_guest_name, '')), '');
  if v_name is null then
    return jsonb_build_object('ok', false, 'code', 'NAME_REQUIRED');
  end if;
  if coalesce(p_amount_paise, 0) < 0 then
    return jsonb_build_object('ok', false, 'code', 'BAD_AMOUNT');
  end if;

  v_ref := nullif(btrim(coalesce(p_external_ref, '')), '');
  -- Two staff reading the same email, or a webhook delivered twice.
  if v_ref is not null and exists (
    select 1 from reservations where source = p_channel and external_ref = v_ref
  ) then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_REFERENCE',
                              'reference', v_ref);
  end if;

  select * into v_type from room_types where id = p_room_type_id and active;
  if v_type is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE');
  end if;

  -- Inventory is pooled, so this competes for the same units as everything
  -- else. The exclusion constraint is the arbiter.
  v_res := public.create_reservation(
    jsonb_build_object('name', v_name, 'phone', nullif(btrim(coalesce(p_phone, '')), '')),
    p_checkin, p_checkout,
    jsonb_build_array(jsonb_build_object(
      'roomTypeId', p_room_type_id, 'ratePlanId', null, 'qty', greatest(1, p_units))),
    p_channel, null, p_actor_id, v_actor_label);

  if not (v_res ->> 'ok')::boolean then
    return v_res;
  end if;

  v_id     := (v_res -> 'reservation' ->> 'id')::uuid;
  v_code   := v_res -> 'reservation' ->> 'code';
  v_nights := p_checkout - p_checkin;

  update reservations set external_ref = v_ref where id = v_id;

  insert into folios (reservation_id, status) values (v_id, 'open')
  returning id into v_folio;

  -- A marketplace booking is priced and collected by the marketplace, so the
  -- amount is posted as given and matched by a prepaid payment: nothing owing
  -- at checkout. A direct channel falls back to our own rate calendar.
  if v_channel.kind = 'ota' and p_amount_paise > 0 then
    insert into folio_items (folio_id, kind, description, qty,
                             unit_price_paise, amount_paise, source, posted_by)
    values (v_folio, 'room_night',
            format('%s via %s%s — %s night%s',
                   v_type.name, v_channel.name, coalesce(' ' || v_ref, ''),
                   v_nights, case when v_nights = 1 then '' else 's' end),
            1, p_amount_paise, p_amount_paise, 'channel', p_actor_id);

    insert into payments (folio_id, method, amount_paise, reference, received_by)
    values (v_folio, 'ota_prepaid', p_amount_paise, v_ref, p_actor_id);
  else
    perform public.ensure_room_charges(v_id);
  end if;

  perform public.log_event(
    'reservation.channel_entered',
    format('%s booking for %s entered%s',
           v_channel.name, v_name, coalesce(' (' || v_ref || ')', '')),
    p_actor_id, v_actor_label, v_id, null, v_folio,
    -- p_source is recorded so the feed distinguishes a webhook from a person.
    jsonb_build_object('channel', p_channel, 'reference', v_ref,
                       'amountPaise', p_amount_paise, 'units', p_units,
                       'source', p_source));

  return jsonb_build_object('ok', true, 'reservationId', v_id, 'code', v_code,
                            'folioId', v_folio);
end;
$$;

-- Explicit, because the default is PUBLIC and that is what started all this.
-- authenticated: the /stays/ota form calls this through the cookie client.
-- service_role: the webhook calls it through the admin client.
revoke all on function public.create_channel_reservation(
  text, text, text, date, date, uuid, integer, text, integer, text, uuid, text)
  from public, anon;
grant execute on function public.create_channel_reservation(
  text, text, text, date, date, uuid, integer, text, integer, text, uuid, text)
  to authenticated, service_role;
