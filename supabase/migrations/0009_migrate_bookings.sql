-- Hotel OS foundation — migrate legacy `bookings` into reservations/allocations/folios
--
-- Written separately per §8 step 2. The legacy `bookings` table is NOT dropped and
-- the website keeps writing to it until the booking flow is cut over; this backfills
-- the new model from whatever is already there.
--
-- Traceability + idempotency: each migrated booking records the reservation it
-- became, and only unmigrated rows are processed, so re-running is a no-op.

alter table bookings add column if not exists migrated_reservation_id uuid
  references reservations (id) on delete set null;

-- The paid amount on a legacy booking is real (amount_paise − balance_paise) but the
-- method was never recorded. Inventing 'cash' would corrupt the daily cash close, so
-- record it honestly instead of guessing.
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash', 'upi', 'card', 'razorpay', 'ota_prepaid', 'migrated'));

do $$
declare
  b            record;
  v_res_id     uuid;
  v_unit_id    uuid;
  v_folio_id   uuid;
  v_nights     int;
  v_paid       int;
  v_migrated   int := 0;
  v_no_unit    int := 0;
  v_clashed    int := 0;
begin
  for b in
    select * from bookings where migrated_reservation_id is null order by created_at
  loop
    v_nights := b.check_out - b.check_in;

    -- ---- reservation. 'reserved' has no §3 equivalent; 'confirmed' is the match.
    -- 'zotel' is not in the §3 source list → 'other'.
    insert into reservations (guest_id, status, source, checkin, checkout,
                              adults, children, notes, created_at)
    values (
      b.guest_id,
      case b.status
        when 'reserved'    then 'confirmed'
        when 'checked_in'  then 'checked_in'
        when 'checked_out' then 'checked_out'
        when 'cancelled'   then 'cancelled'
        when 'no_show'     then 'no_show'
        else 'confirmed'
      end,
      case b.source
        when 'website' then 'website'
        when 'walk_in' then 'walk_in'
        when 'ota'     then 'ota_booking'
        else 'other'                                   -- 'zotel' lands here
      end,
      b.check_in, b.check_out,
      greatest(1, coalesce(b.guests, 1)), 0,
      b.notes, b.created_at
    )
    returning id into v_res_id;

    update bookings set migrated_reservation_id = v_res_id where id = b.id;

    -- ---- allocation. Only stays that actually held inventory get one; cancelled
    -- and no-show bookings never occupied a unit. A legacy row whose unit is now
    -- taken (possible: the old constraint ignored non-active statuses) is skipped
    -- rather than failing the whole migration.
    if b.status in ('reserved', 'checked_in', 'checked_out') then
      select u.id into v_unit_id
        from units u
       where u.room_id = b.room_id
         and (u.bed_id is not distinct from b.bed_id)
       limit 1;

      if v_unit_id is null then
        v_no_unit := v_no_unit + 1;
        raise notice 'booking % has no matching unit (room %, bed %) — reservation % left unallocated',
          b.id, b.room_id, b.bed_id, v_res_id;
      else
        begin
          insert into allocations (unit_id, reservation_id, reason, stay, created_at)
          values (v_unit_id, v_res_id, 'booking',
                  daterange(b.check_in, b.check_out, '[)'), b.created_at);
        exception when exclusion_violation then
          v_clashed := v_clashed + 1;
          raise notice 'booking % overlaps an existing allocation on unit % — skipped',
            b.id, v_unit_id;
        end;
      end if;
    end if;

    -- ---- folio: the room charge, plus whatever was already paid.
    if coalesce(b.amount_paise, 0) > 0 then
      insert into folios (reservation_id, status, created_at)
      values (v_res_id,
              case when b.status in ('checked_out', 'cancelled') then 'settled' else 'open' end,
              b.created_at)
      returning id into v_folio_id;

      insert into folio_items (folio_id, kind, description, qty,
                               unit_price_paise, amount_paise, source, posted_at)
      values (
        v_folio_id, 'room_night',
        format('%s night%s (migrated from booking)', v_nights,
               case when v_nights = 1 then '' else 's' end),
        v_nights,
        case when v_nights > 0 then b.amount_paise / v_nights else b.amount_paise end,
        b.amount_paise, 'booking', b.created_at
      );

      v_paid := coalesce(b.amount_paise, 0) - coalesce(b.balance_paise, 0);
      if v_paid > 0 then
        insert into payments (folio_id, method, amount_paise, reference, received_at)
        values (v_folio_id, 'migrated', v_paid, 'migrated-from-bookings.' || b.id, b.created_at);
      end if;
    end if;

    v_migrated := v_migrated + 1;
  end loop;

  raise notice 'migrated % booking(s); % unallocated (no unit); % skipped (date clash)',
    v_migrated, v_no_unit, v_clashed;
end $$;
