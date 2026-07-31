-- Stays — housekeeping (ROADMAP M2 item 5)
--
-- Deliberately not a module. `rooms.housekeeping` has existed since 0005 and
-- checkout already sets it to 'dirty'; all that was missing was a way for staff
-- to set it back. This adds exactly that, plus the event so the desk can see who
-- cleared a room.
--
-- NOTE ON 'out_of_order': this is a DISPLAY state, not a sales block. Foundation
-- §3 is explicit that taking a unit off sale is an `allocations` row with
-- reason='maintenance' — one mechanism, enforced by the exclusion constraint.
-- Marking a room out of order does NOT stop it being sold; block it on the board
-- as well. The function returns a flag so the UI can say so.

create or replace function public.set_room_housekeeping(
  p_room_id     uuid,
  p_status      text,
  p_actor_id    uuid default null,
  p_actor_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room     record;
  v_blocked  boolean;
begin
  -- Housekeeping staff are the point of this screen, so they are included here
  -- even though they cannot touch bookings.
  if coalesce(public.user_role(), '') not in
     ('owner', 'manager', 'reception', 'housekeeping') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('clean', 'dirty', 'inspected', 'out_of_order') then
    return jsonb_build_object('ok', false, 'code', 'BAD_STATUS');
  end if;

  select * into v_room from rooms where id = p_room_id;
  if v_room is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  -- Nothing to say, nothing to log.
  if v_room.housekeeping = p_status then
    return jsonb_build_object('ok', true, 'status', p_status, 'unchanged', true);
  end if;

  update rooms set housekeeping = p_status where id = p_room_id;

  -- Is this room actually off sale today, or only labelled out of order?
  select exists (
    select 1
      from allocations a
      join units u on u.id = a.unit_id
     where u.room_id = p_room_id
       and a.reason <> 'booking'
       and a.stay @> (now() at time zone 'Asia/Kolkata')::date
  ) into v_blocked;

  perform public.log_event(
    'room.housekeeping',
    format('%s marked %s', v_room.number, replace(p_status, '_', ' ')),
    p_actor_id, p_actor_label, null, null, null,
    jsonb_build_object('roomId', p_room_id, 'number', v_room.number,
                       'from', v_room.housekeeping, 'to', p_status));

  return jsonb_build_object(
    'ok', true,
    'status', p_status,
    'number', v_room.number,
    -- True when the room is called out of order but nothing stops it selling.
    'needsBlock', (p_status = 'out_of_order' and not v_blocked));
end;
$$;

revoke all on function public.set_room_housekeeping(uuid, text, uuid, text) from public, anon;
grant execute on function public.set_room_housekeeping(uuid, text, uuid, text) to authenticated;
