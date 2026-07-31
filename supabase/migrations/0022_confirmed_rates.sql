-- Confirmed interim prices, and GST left switched off
--
-- Supersedes placeholder #1 in 0008_seed_foundation.sql. These are the owner's
-- real prices as of this migration:
--
--   dorm     ₹300  per bed  per night
--   deluxe   ₹1,800 per room per night   (attached bathroom)
--   premium  ₹1,800 per room per night   (attached bathroom)
--   family   ₹2,000 per room per night   (shared bathroom)
--
-- FLAT for every date. Seasonal, weekend and off-season pricing comes later and
-- is a script that writes `rates` rows — no schema change, by design (§4).
--
-- ⚠️ Re-running this resets every future date to the flat price, including any
-- the owner has since edited by hand. It is a one-time correction of the
-- placeholders, not a routine job.
--
-- GST: the property IS registered but is NOT charging GST yet. Nothing here
-- sets a tax rate. See docs/reception-definitions.md §4 for exactly what has to
-- change when they start — the plumbing is already in place.

-- Two places hold a price today: room_types.base_rate_paise (read by the public
-- booking engine) and the rates calendar (read by the folio). They MUST agree,
-- or a guest is quoted one number and billed another. M3 collapses them to the
-- calendar alone; until then, set both.
update room_types rt
   set base_rate_paise = v.price
  from (values
    ('dorm',     30000),
    ('deluxe',  180000),
    ('premium', 180000),
    ('family',  200000)
  ) as v(code, price)
 where rt.code = v.code;

-- 400 days forward from today at the confirmed price. Past dates keep whatever
-- they were: they are a record of what was actually charged.
insert into rates (room_type_id, rate_plan_id, stay_date, price_paise, closed)
select rt.id, rp.id, d::date, rt.base_rate_paise, false
  from room_types rt
  join rate_plans rp on rp.room_type_id = rt.id and rp.name = 'Direct Flex'
 cross join generate_series(current_date, current_date + 399, interval '1 day') as d
 where rt.active
   and rt.base_rate_paise > 0
on conflict (room_type_id, rate_plan_id, stay_date)
do update set price_paise = excluded.price_paise, closed = false;
