-- Backpackers Storey — seed data
-- Rooms mirror the website (dorm / deluxe / premium / family). Menu prices are
-- PLACEHOLDERS in paise — edit them in POS → Menu management. Idempotent: every
-- insert is guarded so re-running won't duplicate.

-- ----------------------------------------------------------------- rooms
insert into rooms (name, type, total_beds, is_dorm)
select 'Six-Bed Dormitory', 'dorm', 6, true
where not exists (select 1 from rooms where name = 'Six-Bed Dormitory');

insert into rooms (name, type, total_beds, is_dorm)
select 'Deluxe Room', 'deluxe', 1, false
where not exists (select 1 from rooms where name = 'Deluxe Room');

insert into rooms (name, type, total_beds, is_dorm)
select 'Premium Room', 'premium', 1, false
where not exists (select 1 from rooms where name = 'Premium Room');

insert into rooms (name, type, total_beds, is_dorm)
select 'Family Room', 'family', 2, false
where not exists (select 1 from rooms where name = 'Family Room');

-- ------------------------------------------------------------ dorm beds
insert into beds (room_id, label)
select r.id, b.label
from rooms r
cross join (values ('D1'), ('D2'), ('D3'), ('D4'), ('D5'), ('D6')) as b(label)
where r.is_dorm = true
  and not exists (
    select 1 from beds x where x.room_id = r.id and x.label = b.label
  );

-- ----------------------------------------------- housekeeping (one per room)
insert into housekeeping (room_id, status)
select r.id, 'clean'
from rooms r
where not exists (select 1 from housekeeping h where h.room_id = r.id);

-- --------------------------------------------------------- menu categories
insert into menu_categories (name, sort_order)
select v.name, v.sort
from (values
  ('Coffee & Chai', 1),
  ('Mocktails', 2),
  ('Burgers & Bites', 3),
  ('All-Day Plates', 4)
) as v(name, sort)
where not exists (select 1 from menu_categories c where c.name = v.name);

-- -------------------------------------------------------------- menu items
insert into menu_items (category_id, name, price_paise, kitchen_station)
select c.id, i.name, i.price_paise, i.station
from (values
  ('Coffee & Chai',    'Masala Chai',      4000,  'coffee'),
  ('Coffee & Chai',    'Cappuccino',      12000,  'coffee'),
  ('Coffee & Chai',    'Cold Coffee',     15000,  'coffee'),
  ('Mocktails',        'Virgin Mojito',   18000,  'bar'),
  ('Mocktails',        'Blue Lagoon',     18000,  'bar'),
  ('Burgers & Bites',  'Veg Burger',      16000,  'main'),
  ('Burgers & Bites',  'Chicken Burger',  22000,  'main'),
  ('Burgers & Bites',  'Masala Fries',    12000,  'main'),
  ('All-Day Plates',   'Veg Maggi',        9000,  'main'),
  ('All-Day Plates',   'Pancakes',        18000,  'main'),
  ('All-Day Plates',   'Veg Thali',       22000,  'main')
) as i(cat, name, price_paise, station)
join menu_categories c on c.name = i.cat
where not exists (
  select 1 from menu_items m where m.name = i.name and m.category_id = c.id
);
