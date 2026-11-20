# Netlify deployment — Backpackers Storey portfolio site

Operational notes for the public website at `https://thebackpackerstory.in`.
Companion to `docs/Netlify_portfolio_launch_plan.md` (the audit and the reasoning).
Written 2026-11-16, before the first production deploy.

## 1. What is deployed

| | |
|---|---|
| Host | Netlify. Next.js runs on Netlify's OpenNext-based adapter, which Netlify provisions automatically for Next.js projects — nothing to install, nothing to pin. |
| Production branch | **`main`** |
| Build | `npm run build` → publish `.next` (both set in `netlify.toml`; dashboard build fields stay empty so nothing conflicts) |
| Node | 24 (pinned in `netlify.toml`; the build is verified locally on v24.x) |
| Environment variables | **none** |
| Domain | `thebackpackerstory.in` (primary) and `www.thebackpackerstory.in` (redirects to the primary). HTTPS via Netlify's automatic Let's Encrypt certificate. |
| Public routes | `/`, `/rooms`, `/rooms/wildflower-den`, `/rooms/trailblazers-den`, `/rooms/valley-window`, `/rooms/natures-edge`, `/rooms/mountain-nook`, `/rooms/forest-haven`, `/sitemap.xml`, `/robots.txt`, `/og.jpg` |
| Paused (booking) | `/book` → 307 to `/#visit` · `/booking/[code]` → 404 · `POST /api/book` → 503 · no availability calendar on room pages · every "Book" CTA is a WhatsApp enquiry |
| Absent (staff) | `/login`, `/pos/*`, `/stays/*`, `/reception`, `/stays/arrivals/form-c`, `/api/channel/*` → 404 because `STAFF_PORTAL_ENABLED` is unset |

## 2. Branches

| Branch | Role |
|---|---|
| `main` | What Netlify builds. Fast-forwarded to `redesign/marketing` at launch (2026-11-16), so the two were identical at that point. |
| `redesign/marketing` | Design work. To release: fast-forward `main` to it (`git fetch . redesign/marketing:main && git push origin main`) or merge it into `main`. |
| `feat/booking-gateway` | Booking engine v2 (holds, Razorpay deposits, cancellation and refund accounting). **Never deployed to this site.** Keep Branch deploys = None and Deploy Previews off so it can never build here by accident. |

## 3. First deploy (manual, in the Netlify dashboard)

1. **Add new project → Import an existing project → GitHub.** Install the Netlify GitHub App on the `Whatever-Piyush` account; when asked for repository access choose **Only select repositories → `TheBackpackStorey`**. (Access can be changed later at github.com/settings/installations.)
2. Pick the repository. **Branch to deploy: `main`.** Leave build command, publish directory and base directory empty — `netlify.toml` provides them. Add **no** environment variables.
3. Deploy. In the build log expect the Next.js adapter being provisioned and `▲ Next.js 16.2.9 (Turbopack)`, then a successful deploy.
4. Smoke-test `https://<site-name>.netlify.app` with §6 before touching DNS.
5. **Project configuration → Build & deploy → Continuous deployment → Branches and deploy contexts → Configure:** Production branch `main`; Branch deploys **None**; Deploy Previews **None**.

## 4. Domain and DNS (Netlify DNS, apex primary)

1. **Domain management → Add a domain → `thebackpackerstory.in`.** Netlify adds both the apex and `www`. Make the **apex** the primary domain; `www` then redirects to it automatically.
2. **Team → DNS → `thebackpackerstory.in` → Name servers.** Copy the four `dnsN.p0N.nsone.net` name servers shown there (the exact list is only shown in the dashboard).
3. At the registrar, replace the current name servers with those four. Propagation can take up to 24 hours.
4. **Domain management → HTTPS.** Wait for the automatic Let's Encrypt certificate, confirm it covers both hostnames, and confirm HTTP→HTTPS forcing is on. The site also sends `Strict-Transport-Security: max-age=31536000` (no preload, no subdomains).
5. Re-run §6 against both hostnames; `https://www.thebackpackerstory.in/` must redirect (301) to `https://thebackpackerstory.in/`.

**External-DNS alternative** (only if the name servers cannot be changed): at the DNS provider create `www` → CNAME → `<site-name>.netlify.app` (Netlify shows the exact target), and the apex → ALIAS / ANAME / flattened CNAME → `apex-loadbalancer.netlify.com`, or, if the provider has no ALIAS-type record, apex → A → `75.2.60.5` (Netlify's documented load-balancer address; confirm against the value the dashboard shows). With external DNS Netlify recommends making **`www` the primary domain**; if you do that, change `SITE.url` in `src/lib/site.ts` to `https://www.thebackpackerstory.in` and redeploy so the canonical URLs and sitemap match.

## 5. Environment variables

None are required for the portfolio deployment. For reference:

| Variable | Needed here? | Notes |
|---|---|---|
| `NODE_VERSION` | set in `netlify.toml` | build only |
| `STAFF_PORTAL_ENABLED` | **leave unset** | server-side switch; `true` only where the staff portal should exist (local dev, or a separate ops site) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no | public; only when booking is un-paused or the portal is enabled. Inlined at build time — set before building. |
| `SUPABASE_SERVICE_ROLE_KEY` | no | **secret**, server-side only; never `NEXT_PUBLIC_`. Only when booking is un-paused or the portal is enabled. |
| `CHANNEL_SYNC_SECRET`, `RESEND_API_KEY`, `BOOKING_FROM_EMAIL`, `CASHFREE_*`, `DATABASE_URL`, `CHANNEL_MOCK_SECRET` | no | PMS / booking / backup concerns; never on the portfolio site |

## 6. Smoke test

```bash
B=https://thebackpackerstory.in      # or https://<site-name>.netlify.app before DNS

for p in / /rooms /rooms/wildflower-den /rooms/trailblazers-den /rooms/valley-window /rooms/natures-edge /rooms/mountain-nook /rooms/forest-haven /sitemap.xml /robots.txt /og.jpg; do
  printf "%-18s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$B$p")"      # all 200
done
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' "$B/book"              # 307 -> /#visit
curl -s -o /dev/null -w '%{http_code}\n' "$B/booking/ABC123"                        # 404
curl -s -X POST -H 'content-type: application/json' -d '{}' "$B/api/book"; echo    # 503 {"ok":false,"error":"Online booking is paused..."}
for p in /login /pos /stays /reception /api/channel/sync; do
  printf "%-18s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B$p")" # 404 (GET for the pages also 404)
done
curl -sI "$B/" | grep -iE 'strict-transport|x-content-type|x-frame|referrer-policy|permissions-policy'
curl -s "$B/sitemap.xml" | grep -o '<loc>[^<]*' | sed 's/<loc>//'                   # 8 URLs on the launch domain
```

Then in a browser at phone, tablet and desktop widths: the header/footer/hero/room-page CTAs open `wa.me/919816610852` with the prefilled text (room pages name the room); phone links dial; the map embed and "Get directions" work; the gallery lightbox, rooms fan, scroll background and moon scene run; no console errors; `view-source` shows `<link rel="canonical">`, `og:image` and `og:url` on the launch domain.

## 7. Un-pausing booking / enabling the staff portal

- **Booking:** set `BOOKING_PAUSED = false` in `src/lib/launch.ts`, add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (secret) to the host, redeploy. The original CTAs, `/book`, the calendar, the lookup and `POST /api/book` return exactly as before — nothing was deleted.
- **Staff portal:** set `STAFF_PORTAL_ENABLED=true` plus the three Supabase variables on whichever host should run it. Prefer a separate Netlify site built from the same branch rather than the public domain.
- **Locally:** `STAFF_PORTAL_ENABLED=true` in `.env.local` keeps the portal available in `npm run dev` (it is documented in `.env.example`).

## 8. Where things live

| File | Purpose |
|---|---|
| `netlify.toml` | build command, publish directory, Node version |
| `next.config.ts` | security headers (`headers()`), view transitions |
| `src/lib/launch.ts` | `BOOKING_PAUSED` (client-safe constant) |
| `src/lib/launch-server.ts` | `STAFF_PORTAL_ENABLED` (server-only env read) |
| `src/lib/site.ts` | launch domain (`SITE.url`), WhatsApp number, `whatsappEnquiryLink()`, all site content |
| `src/components/booking-button.tsx` | the CTA that is a WhatsApp enquiry while paused |
| `src/app/robots.ts`, `src/app/sitemap.ts`, `public/og.jpg` | SEO: crawl rules, sitemap, social-preview image |
| `src/proxy.ts` | when the portal is off: staff paths → 404 before any page code runs, everything else passes straight through; when it is on: Supabase session refresh + optimistic `/login` redirect |
