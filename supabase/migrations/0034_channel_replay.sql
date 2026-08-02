-- Replay and retry handling for inbound channel reservations
--
-- A signature proves a request was genuine ONCE. It does not stop that request
-- being sent again: a captured payload replayed inside the ±5 minute window
-- carries a perfectly valid signature every time. Timestamps narrow the window;
-- they cannot close it. Only the database can.
--
-- Two unique indexes already do the work, both from earlier migrations:
--
--   channel_inbox_external_key   unique (provider_id, external_id)
--   reservations_external_ref_key unique (source, external_ref)
--                                 where external_ref is not null
--
-- Verified: the same message replayed three times yields exactly one reservation.
-- What was missing is the SHAPE of the refusal.
--
-- 1. DUPLICATE_REFERENCE returned only the reference, so a Channel Manager
--    retrying a request it believed had failed learned that a booking existed but
--    not which one. It cannot reconcile from that, so it retries forever.
--
-- 2. The duplicate test was `exists (select ...)` — check-then-hope. Two
--    simultaneous deliveries could both pass it, and the loser then hit a raw
--    23505 on the external_ref UPDATE, surfacing as an unhandled exception rather
--    than a clean, expected duplicate.
--
-- This makes the refusal constraint-backed and informative, matching how
-- allocations already works: insert and handle the violation, never check first
-- and hope nothing changed in between.

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
  v_dup         record;
begin
  -- ------------------------------------------------------------------ guard
  if p_source not in ('webhook', 'reception') then
    return jsonb_build_object('ok', false, 'code', 'BAD_SOURCE');
  end if;

  if p_source = 'webhook' then
    -- Machine callers only: no end-user session. See 0033 for why this is
    -- auth.uid() and not current_user or session_user.
    if auth.uid() is not null then
      raise exception 'not permitted' using errcode = 'insufficient_privilege';
    end if;
  else
    if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
      raise exception 'not permitted' using errcode = 'insufficient_privilege';
    end if;
  end if;

  v_actor_label := coalesce(
    nullif(btrim(coalesce(p_actor_label, '')), ''),
    case p_source when 'webhook' then 'Channel webhook' else 'Reception' end);

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

  -- Fast path. Not the guarantee — the constraint below is — but it avoids
  -- doing the work only to throw it away on the common retry.
  if v_ref is not null then
    select r.id, r.code into v_dup
      from reservations r
     where r.source = p_channel and r.external_ref = v_ref;
    if found then
      -- The retry answer a Channel Manager can actually use: which booking this
      -- reference already became. Without it, it cannot reconcile and keeps
      -- resending forever.
      return jsonb_build_object('ok', false, 'code', 'DUPLICATE_REFERENCE',
                                'reference', v_ref,
                                'reservationId', v_dup.id,
                                'reservationCode', v_dup.code);
    end if;
  end if;

  select * into v_type from room_types where id = p_room_type_id and active;
  if v_type is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE');
  end if;

  -- ------------------------------------------------- create, or lose the race
  --
  -- Everything that writes lives inside this block. If a simultaneous delivery
  -- claimed the same reference first, the UPDATE below violates
  -- reservations_external_ref_key, the whole block rolls back — including the
  -- reservation and its allocations — and the duplicate is reported cleanly.
  -- plpgsql variables survive that rollback, so the payload is still readable.
  begin
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
      jsonb_build_object('channel', p_channel, 'reference', v_ref,
                         'amountPaise', p_amount_paise, 'units', p_units,
                         'source', p_source));

  exception when unique_violation then
    -- Only OUR duplicate converts to a clean answer. Any other unique violation
    -- is a real fault and must not be disguised as a retry.
    if v_ref is null then
      raise;
    end if;

    select r.id, r.code into v_dup
      from reservations r
     where r.source = p_channel and r.external_ref = v_ref;
    if not found then
      raise;
    end if;

    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_REFERENCE',
                              'reference', v_ref,
                              'reservationId', v_dup.id,
                              'reservationCode', v_dup.code);
  end;

  return jsonb_build_object('ok', true, 'reservationId', v_id, 'code', v_code,
                            'folioId', v_folio);
end;
$$;

-- Same signature as 0033, so CREATE OR REPLACE keeps the existing ACL. Restated
-- anyway: leaving grants implicit is what produced the finding this all began with.
revoke all on function public.create_channel_reservation(
  text, text, text, date, date, uuid, integer, text, integer, text, uuid, text)
  from public, anon;
grant execute on function public.create_channel_reservation(
  text, text, text, date, date, uuid, integer, text, integer, text, uuid, text)
  to authenticated, service_role;
