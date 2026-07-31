-- Enqueue must not lock other transactions' rows (docs/Channel_manager.md §4)
--
-- 0027's enqueue coalesced by UPDATEing older pending rows to 'superseded'
-- INSIDE the booking transaction. That put a write lock on rows another
-- in-flight booking might hold, so two concurrent bookings for the same room
-- type could block each other — or deadlock, one waiting on an outbox row while
-- the other waited on an allocation.
--
-- That is precisely the contention an outbox exists to avoid. The booking path
-- now only ever INSERTs, which takes no lock anyone else can wait on, and
-- coalescing moves to drain time where it is free: the worker already sends only
-- the newest row per scope.

create or replace function public.enqueue_channel_sync(
  p_kind         text,
  p_room_type_id uuid default null,
  p_from         date default null,
  p_to           date default null,
  p_reservation  uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- INSERT only. The sequence carries the ordering; the worker discards
  -- anything it finds superseded within a batch.
  insert into channel_outbox (kind, room_type_id, from_date, to_date, reservation_id,
                              requires_ack)
  values (p_kind, p_room_type_id, p_from, p_to, p_reservation,
          public.distribution_mode() = 'manual');
end;
$$;

/** Stand down a row the worker found stale. Never called from a booking. */
create or replace function public.supersede_channel_sync(p_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update channel_outbox
     set status = 'superseded', sent_at = now()
   where id = p_id and status <> 'sent';
$$;

revoke all on function public.supersede_channel_sync(uuid) from public, anon, authenticated;
