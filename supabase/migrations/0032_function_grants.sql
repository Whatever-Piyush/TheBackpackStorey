-- Function execute grants (ROADMAP §4 item 3)
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and PUBLIC
-- includes anon. Migrations 0010, 0011 and 0012 each revoked create_reservation —
-- but a REVOKE names a SIGNATURE, and 0028 created a new one (dropping
-- p_respect_allotment, adding the actor columns). New signature, new object,
-- fresh default grant, and the earlier revokes did not carry over.
--
-- This clears that grant everywhere it is still present, so tests/grants.test.mts
-- can assert its absence instead of trusting every future migration to remember.
--
-- Nothing here changes what any function DOES. Grants only.

-- ------------------------------------------------- the two the review found
--
-- sync_units_for_room is SECURITY DEFINER and writes to units. anon could call
-- it — demonstrated, not theorised: it executed, and each call also fired the
-- sync triggers, appending to channel_outbox without limit.
--
-- Its only callers are the trigger functions in 0005. A trigger runs its function
-- under the definer's rights and does NOT re-check EXECUTE at fire time (Postgres
-- checks that when the trigger is created), so revoking here cannot break room or
-- bed creation. Verified against this schema before writing the revoke.
revoke all on function public.sync_units_for_room(uuid) from public, anon, authenticated;

-- create_reservation is SECURITY INVOKER, so anon was stopped by table grants
-- rather than by this one — it died on "permission denied for table channels".
-- That defence is invisible and evaporates the day someone makes the function
-- SECURITY DEFINER, which is why the grant goes now rather than later.
revoke all on function public.create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text)
  from public, anon, authenticated;

-- /api/book reaches it through the service-role client. Granted explicitly rather
-- than leaning on Supabase's default privileges, which the local test harness does
-- not reproduce — the same implicitness that caused this finding.
grant execute on function public.create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text)
  to service_role;

-- --------------------------------------------------------------- user_role()
--
-- Pulled forward from item 6 because the approved regression test cannot pass
-- while any function still carries the default grant.
--
-- 19 RLS policies call this function. Revoking from PUBLIC without granting it
-- back to authenticated would make every one of them raise "permission denied for
-- function user_role" — so the grant is explicit and deliberate.
revoke all on function public.user_role() from public, anon;
grant execute on function public.user_role() to authenticated, service_role;

-- ------------------------------------------------------------------ helpers
--
-- Called only from inside other functions, which execute them under their own
-- (definer) rights. is_foreign_national is referenced once in src/, but as a
-- comment noting the TypeScript copy is kept in sync — not as an RPC call.
revoke all on function public.gen_reservation_code() from public, anon, authenticated;
revoke all on function public.is_foreign_national(text) from public, anon, authenticated;
revoke all on function public.pos_item_kind(text) from public, anon, authenticated;

-- -------------------------------------------------------- trigger functions
--
-- Not directly callable — Postgres refuses with "trigger functions can only be
-- called as triggers" — so these are tidiness rather than exposure. They are
-- revoked anyway so the regression test can be absolute: any function carrying a
-- PUBLIC execute grant is a finding, with no allowlist to argue about.
revoke all on function public.allocations_enqueue_sync()      from public, anon, authenticated;
revoke all on function public.events_immutable()              from public, anon, authenticated;
revoke all on function public.handle_new_user()               from public, anon, authenticated;
revoke all on function public.post_room_charges_on_checkin()  from public, anon, authenticated;
revoke all on function public.rates_enqueue_sync()            from public, anon, authenticated;
revoke all on function public.set_updated_at()                from public, anon, authenticated;
revoke all on function public.sync_order_served()             from public, anon, authenticated;
revoke all on function public.sync_reservation_lead_guest()   from public, anon, authenticated;
revoke all on function public.units_bed_sync()                from public, anon, authenticated;
revoke all on function public.units_enqueue_sync()            from public, anon, authenticated;
revoke all on function public.units_room_sync()               from public, anon, authenticated;
revoke all on function public.units_type_sync()               from public, anon, authenticated;
