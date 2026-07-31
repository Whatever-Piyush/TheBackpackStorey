-- Inbound channel reservations + sync status (docs/Channel_manager.md §3b, §5)
--
-- Everything arriving from a Channel Manager lands here first, is deduplicated,
-- and is then handed to the SAME reservation engine the website uses. A webhook
-- retry cannot book twice, and a reservation that cannot be placed is never
-- silently dropped — it becomes a task for staff.

create table if not exists channel_inbox (
  id             uuid primary key default gen_random_uuid(),
  provider_id    text not null,
  -- The Channel Manager's own id for this message. The dedupe key.
  external_id    text not null,
  kind           text not null check (kind in ('reservation', 'cancellation', 'modification')),
  channel        text references channels (code),
  payload        jsonb not null,
  status         text not null default 'pending'
                 check (status in ('pending', 'applied', 'duplicate', 'failed')),
  reservation_id uuid references reservations (id) on delete set null,
  error          text,
  received_at    timestamptz not null default now(),
  resolved_at    timestamptz,
  -- Staff clearing an overbooking or a rejected message.
  resolved_by    uuid references auth.users (id),
  resolution     text
);

-- A retried webhook is the normal case, not an error.
create unique index if not exists channel_inbox_external_key
  on channel_inbox (provider_id, external_id);
create index if not exists channel_inbox_failed_idx
  on channel_inbox (received_at desc) where status = 'failed' and resolved_at is null;

alter table channel_inbox enable row level security;
revoke all on channel_inbox from anon, authenticated;

/**
 * Claim an inbound message. Returns `{fresh:false}` when this id has been seen
 * before, so the caller stops rather than re-applying it.
 */
create or replace function public.claim_channel_inbound(
  p_provider_id text,
  p_external_id text,
  p_kind        text,
  p_channel     text,
  p_payload     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row channel_inbox%rowtype;
begin
  insert into channel_inbox (provider_id, external_id, kind, channel, payload)
  values (p_provider_id, p_external_id, p_kind, p_channel, p_payload)
  on conflict (provider_id, external_id) do nothing;

  if found then
    return jsonb_build_object('fresh', true);
  end if;

  select * into v_row from channel_inbox
   where provider_id = p_provider_id and external_id = p_external_id;

  return jsonb_build_object('fresh', false, 'status', v_row.status,
                            'reservationId', v_row.reservation_id);
end;
$$;

create or replace function public.complete_channel_inbound(
  p_provider_id    text,
  p_external_id    text,
  p_status         text,
  p_reservation_id uuid default null,
  p_error          text default null
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update channel_inbox
     set status = p_status,
         reservation_id = coalesce(p_reservation_id, reservation_id),
         error = p_error,
         resolved_at = case when p_status in ('applied', 'duplicate') then now() end
   where provider_id = p_provider_id and external_id = p_external_id;
$$;

-- ------------------------------------------------- channel-agnostic booking
-- Replaces create_ota_booking. It takes a CHANNEL CODE, not an OTA name, and
-- has no idea which Channel Manager (if any) delivered it.
drop function if exists public.create_ota_booking(text, text, text, date, date, uuid, integer, text, integer, uuid, text);

create or replace function public.create_channel_reservation(
  p_channel      text,
  p_guest_name   text,
  p_phone        text,
  p_checkin      date,
  p_checkout     date,
  p_room_type_id uuid,
  p_units        integer,
  p_external_ref text,
  p_amount_paise integer,
  p_actor_id     uuid default null,
  p_actor_label  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel record;
  v_type    record;
  v_res     jsonb;
  v_id      uuid;
  v_code    text;
  v_folio   uuid;
  v_name    text;
  v_ref     text;
  v_nights  integer;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

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
    p_channel, null, p_actor_id, p_actor_label);

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
    p_actor_id, p_actor_label, v_id, null, v_folio,
    jsonb_build_object('channel', p_channel, 'reference', v_ref,
                       'amountPaise', p_amount_paise, 'units', p_units));

  return jsonb_build_object('ok', true, 'reservationId', v_id, 'code', v_code,
                            'folioId', v_folio);
end;
$$;

-- ------------------------------------------------------------- sync status
-- Everything /stays/channel needs, in one call.
create or replace function public.channel_status(p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'distributionMode', public.distribution_mode(),
    'provider', (
      select jsonb_build_object('providerId', cp.provider_id, 'label', cp.label)
        from channel_providers cp where cp.active limit 1
    ),
    'queue', (
      select jsonb_build_object(
               'pending',  count(*) filter (where status = 'pending'),
               'failed',   count(*) filter (where status = 'failed'),
               'awaitingAck', count(*) filter (where requires_ack and acknowledged_at is null
                                                 and status <> 'superseded'),
               'sentToday', count(*) filter (
                 where status = 'sent'
                   and sent_at >= ((now() at time zone 'Asia/Kolkata')::date)::timestamptz))
        from channel_outbox
    ),
    'lastSent', (
      select jsonb_object_agg(kind, at) from (
        select kind, max(sent_at) as at from channel_outbox
         where status = 'sent' group by kind
      ) s
    ),
    -- Retry visibility: what is stuck, why, and when it will be tried again.
    'attention', coalesce((
      select jsonb_agg(x order by x ->> 'createdAt' desc)
        from (
          select jsonb_build_object(
                   'id', o.id, 'kind', o.kind, 'status', o.status,
                   'roomType', rt.name,
                   'from', o.from_date, 'to', o.to_date,
                   'attempts', o.attempts,
                   'nextAttemptAt', o.next_attempt_at,
                   'lastError', o.last_error,
                   'requiresAck', o.requires_ack,
                   'createdAt', o.created_at) as x
            from channel_outbox o
            left join room_types rt on rt.id = o.room_type_id
           where o.status = 'failed'
              or (o.requires_ack and o.acknowledged_at is null and o.status <> 'superseded')
           order by o.created_at desc
           limit p_limit
        ) s
    ), '[]'::jsonb),
    -- Inbound messages that could not be placed: an overbooking, or a payload we
    -- could not read. A human has to decide.
    'inboundFailures', coalesce((
      select jsonb_agg(x order by x ->> 'receivedAt' desc)
        from (
          select jsonb_build_object(
                   'id', i.id, 'providerId', i.provider_id,
                   'externalId', i.external_id, 'kind', i.kind,
                   'channel', i.channel, 'error', i.error,
                   'receivedAt', i.received_at) as x
            from channel_inbox i
           where i.status = 'failed' and i.resolved_at is null
           order by i.received_at desc
           limit p_limit
        ) s
    ), '[]'::jsonb)
  );
end;
$$;

/** Staff dismissing an inbound message they have dealt with by hand. */
create or replace function public.resolve_channel_inbound(
  p_id         uuid,
  p_resolution text,
  p_actor_id   uuid default null
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

  update channel_inbox
     set resolved_at = now(), resolved_by = p_actor_id,
         resolution = nullif(btrim(coalesce(p_resolution, '')), '')
   where id = p_id and resolved_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.claim_channel_inbound(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.complete_channel_inbound(text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.create_channel_reservation(text, text, text, date, date, uuid, integer, text, integer, uuid, text) from public, anon;
revoke all on function public.channel_status(integer) from public, anon;
revoke all on function public.resolve_channel_inbound(uuid, text, uuid) from public, anon;

grant execute on function public.create_channel_reservation(text, text, text, date, date, uuid, integer, text, integer, uuid, text) to authenticated;
grant execute on function public.channel_status(integer) to authenticated;
grant execute on function public.resolve_channel_inbound(uuid, text, uuid) to authenticated;
