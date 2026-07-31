-- Hotel OS foundation — seed (docs/foundation.md §8 step 3)
--
-- Idempotent throughout: every insert is guarded and every update only touches a
-- value that is still at its migrated default. Re-running never overwrites a price
-- or an allotment the owner has edited.
--
-- ⚠️ PLACEHOLDERS USED — every one of these needs the owner to confirm (§9.2):
--
--   1. Nightly rates: dorm ₹600/bed, deluxe ₹1,800, premium ₹2,500, family ₹3,200.
--      Carried over from the constants that used to be hardcoded in
--      src/lib/booking/rates.ts, where they were already marked placeholder.
--   2. Rates are FLAT for all 400 days. No weekend uplift, no March–June Bir
--      season, no Diwali. §4 says those are scripts that write rows — not written.
--   3. Room numbers: 'Dorm A', '101', '102', '103'. The property's real room
--      identifiers are unknown.
--   4. Dorm bed positions: D1–D6 alternating lower/upper, i.e. assumed 3 bunks.
--      Could equally be 6 singles.
--   5. Direct allotment: 2 of 6 dorm beds, 1 of each private room. §5's own
--      example numbers, not a decision the owner has made.
--   6. Floors: left NULL — unknown.
--   7. gender_policy: 'any' for the dorm (§2 default). Mixed vs female-only
--      is unconfirmed.
--   8. Rate plan: one 'Direct Flex', refundable, 24h cancellation, min 1 night.
--      The real cancellation policy is unconfirmed.
--   9. tax_rate on folio lines defaults to 0 — assumes NOT GST-registered (§6).

-- ------------------------------------------------- room numbers / bed positions
-- Only rename where 0005 backfilled `number` from `name` (i.e. still untouched).
update rooms set number = 'Dorm A' where number = 'Six-Bed Dormitory';
update rooms set number = '101'    where number = 'Deluxe Room';
update rooms set number = '102'    where number = 'Premium Room';
update rooms set number = '103'    where number = 'Family Room';

-- Assume 3 bunks: odd labels lower, even upper.
update beds set position = case
    when right(label, 1)::int % 2 = 1 then 'lower' else 'upper' end
 where position is null and label ~ '^D[0-9]+$';

-- --------------------------------------------------------------- rate plans
-- §8 step 3: one Direct Flex plan per type.
insert into rate_plans (room_type_id, name, min_nights, refundable, cancel_hours)
select rt.id, 'Direct Flex', 1, true, 24
  from room_types rt
 where rt.active
   and not exists (
     select 1 from rate_plans rp where rp.room_type_id = rt.id and rp.name = 'Direct Flex'
   );

-- -------------------------------------------------------------------- rates
-- 400 days from today, priced from room_types.base_rate_paise so the placeholder
-- number lives in exactly one place. ON CONFLICT DO NOTHING protects owner edits.
insert into rates (room_type_id, rate_plan_id, stay_date, price_paise, closed)
select rt.id, rp.id, d::date, rt.base_rate_paise, false
  from room_types rt
  join rate_plans rp on rp.room_type_id = rt.id and rp.name = 'Direct Flex'
 cross join generate_series(current_date, current_date + 399, interval '1 day') as d
 where rt.active
on conflict (room_type_id, rate_plan_id, stay_date) do nothing;

-- --------------------------------------------------------- direct allotment
-- §5: the units the direct engine may sell. These MUST be closed in every OTA
-- extranet before the booking engine goes live (§9.3) — an OTA booking arrives by
-- email, not by insert, so the exclusion constraint cannot catch a double-sale.
insert into direct_allotment (room_type_id, stay_date, units_for_direct)
select rt.id, d::date, case when rt.sell_mode = 'per_bed' then 2 else 1 end
  from room_types rt
 cross join generate_series(current_date, current_date + 399, interval '1 day') as d
 where rt.active
on conflict (room_type_id, stay_date) do nothing;
