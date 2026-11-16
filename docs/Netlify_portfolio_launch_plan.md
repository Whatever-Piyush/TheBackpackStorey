# Backpackers Storey — portfolio website launch on Netlify

**Status:** plan for review. Nothing in this document has been implemented. No file in either worktree has been modified, committed or pushed. The only commands run were read-only inspection plus a baseline `npm run lint`, `npx tsc --noEmit` and `npm run build` (writes only to the git-ignored `.next/`).

**Post-review update (2026-11-16):** approved as recommended (D1-A, D2-A, D3-A, D4-A; D5 skipped) with one change from the owner: **the final design must live on `main` and Netlify deploys from `main`.** `main` had no commits of its own beyond the shared base, so it is fast-forwarded to `redesign/marketing` (no merge commit, no history rewrite) and the two branches are identical at launch. The OG image is cut from `hero-cafe.jpg` (the only landscape photo; `photo-11.jpg` turned out to be portrait). Two refinements made during implementation: the portal switch lives in `src/lib/launch-server.ts` (server-only) so the env-var read stays out of the client bundle, and the proxy answers staff paths with 404 before any page code runs (the layout/route guards remain as a second line). The implemented state is recorded in `docs/Netlify_deploy.md`.

**Prepared:** 2026-11-16 · **Worktree audited:** `backpackers-redesign` on `redesign/marketing` @ `d96c3c3` (clean, in sync with `origin/redesign/marketing`)

---

## 0. TL;DR

| | |
|---|---|
| **What ships** | The existing marketing site (home, rooms index, 4 room pages, gallery, café, Around Bir, amenities, contact/map) on `https://thebackpackerstory.in`, hosted on Netlify, deployed from GitHub branch `main` (fast-forwarded from `redesign/marketing`). |
| **What is paused** | Every public booking surface on this branch: the "Book" CTAs, `/book`, `/booking/[code]`, the availability calendar on room pages, and `POST /api/book`. All booking CTAs become **WhatsApp enquiry** links with a prefilled message (room-specific on room pages). |
| **What is NOT deleted** | Nothing. The pause is a single `BOOKING_PAUSED` flag; every booking file stays in place. The `feat/booking-gateway` branch and the `backpackers-storey` worktree are not touched at all. |
| **Payment code** | There is **no Razorpay code on this branch** (it lives only on `feat/booking-gateway`). Nothing payment-related needs hiding here; nothing payment-related will be deployed. |
| **Netlify** | New `netlify.toml` (build command, publish dir, Node pin). Netlify auto-provisions its OpenNext-based Next.js adapter — no new dependency. |
| **Env vars on Netlify** | **None required**, if you accept recommendation D1 (staff portal off on the public deployment). The service-role key never leaves `.env.local`. |
| **Decisions I need from you** | D1–D5 in §3. D1 (staff portal) and D2 (apex vs www / where DNS is hosted) change what I build. |
| **Baseline today** | `tsc` ✅ · `next build` ✅ (Turbopack, 17 static pages) · `eslint` ❌ 1 error in a legacy component (trivial fix, §4.7) · DB tests not run (need a local Postgres; Docker daemon not running). |

---

## 1. Scope and guard-rails I will follow

- Work only inside `/Users/batman/Batman/TheBackpackStorey/backpackers-redesign` (branch `redesign/marketing`). Verified: `git branch --show-current` → `redesign/marketing`; `git worktree list` shows the backend worktree at `backpackers-storey` on `feat/booking-gateway`.
- The backend worktree is read-only for this task. I only ran `git branch`, `git status`, `git log` there. Its one untracked item (`.claude/`) stays as is.
- No branch switching, no merges between branches, no history rewriting, no force-push, no stash.
- No commit, no push, no Netlify account action, no DNS change until you explicitly say so (Stage F).
- No invented content: no prices, capacities, distances, reviews, social links or contact details beyond what is already in `src/lib/site.ts`.
- Minimal, reversible changes: every pause is behind a flag; original copy and components remain in the code.

---

## 2. Stage A — audit findings

### 2.1 Repository, worktrees, branches

| Item | Finding |
|---|---|
| Remote | `origin` → `https://github.com/Whatever-Piyush/TheBackpackStorey.git` (private). GitHub default branch: **`main`** — fast-forwarded to the redesign at launch, so Netlify's default selection is the right branch. |
| Marketing worktree | `backpackers-redesign`, branch `redesign/marketing` @ `d96c3c3`, **0 uncommitted changes**, equal to `origin/redesign/marketing`. |
| Backend worktree | `backpackers-storey`, branch `feat/booking-gateway` @ `6a49836` ("fix(payment): add Razorpay refund reconciliation"). Only an untracked `.claude/` directory. |
| Branch relationship | Merge-base of the two branches is `70df7bc` = `main`. `redesign/marketing` is 21 commits ahead of `main` (all marketing/design work). `feat/booking-gateway` is 7 commits ahead of `main` (money-visibility predicate, cancellation policy + deposit config, reservation holds + lazy expiry, Razorpay deposit flow, cancellation/forfeiture accounting, grants fixture fix, refund reconciliation). **Neither branch contains the other's work.** |
| Files that exist only on `feat/booking-gateway` (never on marketing) | `src/lib/payments/razorpay.ts`, `src/app/api/payments/razorpay/{webhook,reconcile}/route.ts`, `src/app/api/booking/[code]/cancel/route.ts`, `src/app/(marketing)/policies/cancellation/page.tsx`, migrations `0038`–`0043`, tests `cancellation*.test.mts`, `holds.test.mts`, `money-authz.test.mts`, `payments.test.mts`, `razorpay-webhook.test.mts`, `refund-reconciliation.test.mts`, docs `gateway-and-policies.md`, `phase9-audit.md`. |
| Consequence | The marketing branch carries the **pre-gateway baseline**: the original "reserve now, pay at property" booking engine, the full PMS/portal, channel-manager code, migrations `0001`–`0037` and 13 DB-level test suites. All of that is preserved untouched by this plan. |

### 2.2 Stack and build configuration

| Item | Finding |
|---|---|
| Framework | **Next.js 16.2.9**, App Router, Turbopack production build. `next` engines: Node `>=20.9.0`. |
| React | **19.2.4** (`react`, `react-dom`). |
| Language / tooling | TypeScript ^5 (strict), ESLint ^9 with `eslint-config-next` 16.2.9 (flat config), Tailwind CSS v4 via `@tailwindcss/postcss`. |
| Package manager | **npm** — `package-lock.json` only (no yarn/pnpm/bun lockfiles). Local: npm 11.4.2, Node v24.3.0. No `.nvmrc` / `.node-version` / `engines` field. |
| Runtime deps | `framer-motion` ^13, `three` ^0.185 + `@react-three/fiber` ^9 + `@react-three/drei` ^10 (WebGL moon), `@supabase/ssr` ^0.12 + `@supabase/supabase-js` ^2.108, `zod` ^4, `date-fns` ^4, `lucide-react` ^1.22. Dev: `pg` (tests only). |
| `next.config.ts` | Only `experimental.viewTransition: true` (React `<ViewTransition>` page transitions). No `output`, no `images`, no `headers`, no `redirects`. |
| Proxy (Next 16's renamed middleware) | `src/proxy.ts` → `src/lib/supabase/proxy-session.ts`: refreshes the Supabase session cookie on every matched request and optimistically redirects unauthenticated `/pos`, `/stays`, `/reception` to `/login`. Matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `photos/` and image extensions. **No-ops when Supabase env vars are absent.** Runs on the Node.js runtime (Next 16 default; `edge` is not allowed in `proxy`). |
| Fonts | `next/font/google` (Bricolage Grotesque, Instrument Sans, Space Mono, Zeyada) — self-hosted at build; Netlify's build container fetches them once at build time. |
| Scripts | `dev`, `build` (`next build`), `start`, `lint` (`eslint`), `test` (`node --test "tests/**/*.test.mts"`). |
| Hosting config | **No `netlify.toml`** (never existed in history), no Netlify packages in `node_modules`, no `vercel.json`. `.github/workflows/backup.yml` is a nightly **database backup** job (GitHub Actions → R2); unrelated to hosting, must stay. |
| Server actions | Present (`"use server"` in `lib/booking/lookup.ts`, `lib/pos/*`, `lib/stays/*`, `lib/channel/status.ts`, `components/reception/shell.tsx`). Supported by the Netlify adapter. |

### 2.3 Route map (from the actual `next build` output)

| Route | Mode | Group | Fate in this launch |
|---|---|---|---|
| `/` | static | marketing | ships |
| `/rooms` | static | marketing | ships |
| `/rooms/[type]` → dorm, deluxe, premium, family | SSG + ISR (`revalidate = 300`) | marketing | ships; availability calendar hidden |
| `/book` | dynamic (`force-dynamic`) | marketing | **paused** (D4: redirect to contact, or 404) |
| `/booking/[code]` | dynamic | marketing | **paused** (404) |
| `/api/book` (POST) | dynamic route handler | public API | **paused** (503 JSON before any DB access) |
| `/sitemap.xml`, `/robots.txt`, `/_not-found` | static | — | ship (robots gets disallow rules) |
| `/login` | static | staff | D1 |
| `/pos`, `/pos/{bills,kitchen,menu,order,today}` | dynamic | staff (portal) | D1 |
| `/stays`, `/stays/{arrivals,board,channel,departures,in-house,ota}`, `/stays/arrivals/form-c` (CSV route) | dynamic | staff (portal) | D1 |
| `/reception` | dynamic | staff (reception) | D1 |
| `/api/channel/sync`, `/api/channel/webhook` (POST) | dynamic | PMS machine endpoints | D1 (fail closed already: sync refuses without `CHANNEL_SYNC_SECRET`; webhook returns 404 unless a channel manager is configured in the DB) |
| Proxy | Node runtime | all non-asset requests | stays; made a no-op when the portal is off |

### 2.4 Booking / payment surface on this branch (what must be hidden)

| Surface | File(s) | Behaviour today |
|---|---|---|
| "Book" CTAs | `src/components/booking-button.tsx` (single centralised `<Link href="/book">`), used by `site-header.tsx` (desktop + mobile menu), `site-footer.tsx`, `marketing/hero.tsx` ("Book a bed"), `marketing/final-cta.tsx` ("Book a bed"), `(marketing)/rooms/page.tsx` ("Check availability"), `(marketing)/rooms/[type]/page.tsx` ("Book this bed/room") | All route to `/book` |
| Copy pointing at the booking page | `marketing/rooms-showcase.tsx` ("Live rates and availability open on the booking page."), `marketing/room-journey-card.tsx` ("Live rates on the booking page"), `(marketing)/rooms/page.tsx` ("Rates and live availability open on the booking page."), `(marketing)/rooms/[type]/page.tsx` ("When you can stay … pick your dates on the booking page") | Would dangle once `/book` is paused |
| Booking checkout | `(marketing)/book/page.tsx` + `components/booking/booking-widget.tsx` (3-step widget, calls `POST /api/book`) | Live |
| Availability calendar | `components/booking/availability-calendar.tsx`, fed by `lib/booking/availability.ts` (anon RPC `public_availability`, degrades to `null`) | Rendered on every room page and in the widget |
| Reservation creation | `src/app/api/book/route.ts` (service-role, rate-limited, idempotent `create_reservation`) | Live |
| Guest booking management | `(marketing)/booking/[code]/page.tsx` + `components/booking/booking-lookup.tsx` + server action `lib/booking/lookup.ts` (service-role) | Live |
| Booking holds, Razorpay checkout, advance payment, cancellation/refund UI | — | **Not on this branch** (only on `feat/booking-gateway`). Nothing to hide. |
| Cashfree | `.env.local` has `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` names (blank per `codebase.md`); **no code references** anywhere in `src/` | Nothing to do; never goes to Netlify |
| Zotel | `SITE.bookingUrl` constant (unused) | Leave as is |

### 2.5 Staff portal and PMS endpoints on this branch (decision D1)

The marketing branch also contains the full staff portal (`/login`, `/pos/*`, `/stays/*`, `/reception`) and the channel-manager API. They are auth-gated (proxy + `requireUser()` / `requireStaff()`), but:

- They need `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and — for the webhook, inventory, check-in, channel modules (`createAdminClient` is used by 8 server modules) — `SUPABASE_SERVICE_ROLE_KEY` on the host.
- Nothing is deployed anywhere today (`docs/Runbook.md` steps 5–7 are unticked; `codebase.md` says localhost), so staff are not relying on a hosted portal.
- Shipping them on the public portfolio domain means a visible staff login at `thebackpackerstory.in/login` and the service-role key living in Netlify's environment, both unnecessary for a portfolio site.

**Recommendation (D1-A):** gate them behind a server-only env flag `STAFF_PORTAL_ENABLED` that is set to `true` in `.env.local` for local work and **left unset on Netlify**, so those routes return 404 on the public site. No code is deleted; the PMS keeps working locally and can be hosted separately later.

### 2.6 Content, assets, media

| Item | Finding |
|---|---|
| Content source | Everything is in `src/lib/site.ts` (no CMS, no runtime fetch for copy): name, tagline, description, address `Bir, Himachal Pradesh 176077, India`, coords `32.0419, 76.7197`, elevations, check-in 2:00 PM / check-out 11:00 AM, phones, WhatsApp, 14 photos with alt text, 4 rooms (dorm ×6, deluxe ×2, premium ×2–3, family ×4) with features, 12 amenities, café, 3 experiences, 5 "Around Bir" attractions with distances, Google Maps embed/directions URLs, "getting here" text. |
| Photos | `public/photos/` — 14 JPGs, 3.5 MB (property's own; `photos-source-map.txt` records provenance). Served through `next/image` (local, no remote patterns needed). |
| Scroll backgrounds | `public/scroll-interpolated/desktop/` — 537 WebP, 26 MB (used); `public/scroll-spike/mobile/` — 120 WebP, 4.3 MB (used). Fetched as blobs by `marketing/scroll-sequence.tsx`; tiered by device capability; reduced-motion/low-memory get a static fallback. |
| **Unreferenced assets** | `public/scroll/` — 300 JPG frames, **27 MB, referenced by no code** (superseded by the interpolated set). Also create-next-app leftovers `file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`, and the stock Next favicon (`src/app/favicon.ico`, md5 `c30c7d42…`). Harmless, but dead weight (D5). |
| Nearby-attraction photos | `ATTRACTIONS[].photo` points at `/photos/nearby/*.jpg` which **do not exist**; `around-bir.tsx` deliberately renders icon-led rows and never uses the field. No broken images. |
| Videos | **None in the repository.** The task mentions videos; the only motion media is the paragliding frame sequence. Nothing to add unless you supply files. |
| WebGL | `three` moon scene (`lunar-scene.tsx`) loaded client-only via dynamic import; pauses off-screen; texture served locally. |
| Totals | `public/` = 61 MB, 977 files (657 webp, 315 jpg, 5 svg). Max files in one directory = 537 (Netlify limit is 54,000 per directory). |

### 2.7 SEO, metadata, sitemap, robots

| Item | Finding | Action |
|---|---|---|
| `metadataBase` | `new URL(SITE.url)` with `SITE.url = "https://backpackersstorey.com"` — a **placeholder, wrong domain** | set to the launch domain (D2 decides apex vs www) |
| Titles/description | Root template `%s · Backpackers Storey`, per-page titles on rooms; OG `type/siteName/title/description/locale en_IN`; Twitter `summary_large_image` | keep |
| OG / Twitter image | **None configured** — link previews (WhatsApp, Instagram DMs, Google) will have no image | D3 |
| Canonical URLs | Not set anywhere | add per-page `alternates.canonical` for `/`, `/rooms`, `/rooms/[type]` |
| `sitemap.ts` | `/`, `/rooms`, `/rooms/{dorm,deluxe,premium,family}` built from `SITE.url` | correct once `SITE.url` is fixed |
| `robots.ts` | `allow: /` + sitemap link | add `disallow` for `/book`, `/booking/`, `/api/`, `/login`, `/pos`, `/stays`, `/reception` |
| noindex pages | `/login`, `/reception`, `/booking/[code]` already `robots: noindex` | keep |
| Domain naming | Task domain is `thebackpackerstory.in`. The docs on this branch refer to the **existing live domain `backpackerstorey.in`** (still pointing at Zotel per `docs/Roadmap.md`). Two different domains. | confirm spelling; the old domain is out of scope (no DNS change) |

### 2.8 Contact, WhatsApp, map, social

| Item | Finding |
|---|---|
| Phones | `+91 98166 10852`, `+91 78272 22036` (`tel:` links in footer, final CTA, room pages). |
| WhatsApp | `+91 98166 10852`; footer already has two `wa.me` links with the prefilled text "Hi Backpackers Storey! I'd like to ask about a booking." |
| Map | Keyless Google Maps iframe embed + "Get directions" link (both from the coords). |
| Getting here | `GETTING_HERE` text (Gaggal/Kangra airport, Delhi→Baijnath buses). |
| Social media | **No Instagram/Facebook/other links exist in code or docs.** I will not invent any. If you give me handles, adding them to the footer is a 5-line change. |

### 2.9 Environment variables (names only — values were never read or printed)

| Variable | Where used | Public/secret | Needed on Netlify for the portfolio? |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `lib/supabase/config.ts`, `admin.ts` | public (inlined in client bundle) | **No** with D1-A + booking paused (all readers degrade safely when unset). Yes if D1-B. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `lib/supabase/config.ts` | public | same as above |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase/admin.ts` (server only) | **secret** | **No** with D1-A. Yes if D1-B. Never `NEXT_PUBLIC_`. |
| `RESEND_API_KEY`, `BOOKING_FROM_EMAIL` | `lib/booking/notify.ts` (booking emails) | secret / config | No (booking paused) |
| `CHANNEL_SYNC_SECRET` | `api/channel/sync` | secret | No with D1-A |
| `CHANNEL_MOCK_SECRET` | `lib/channel/providers/mock.ts` | secret | No |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` | present in `.env.local` only; **unused in code** | secret | No |
| `DATABASE_URL` | tests + backup scripts only | secret | No |
| `STAFF_PORTAL_ENABLED` (new, D1-A) | `lib/launch.ts` | server config | Leave **unset** on Netlify (portal off); `true` locally |

Hygiene: `.env.local` and `.env.development.local` are git-ignored (`.env*`) and have never been tracked; only `.env.example` is committed. `.env.development.local` contains only commented-out local-Supabase lines. The repo's `.gitignore` already covers `.netlify`-style needs (`.vercel` entry is harmless).

### 2.10 Baseline checks (run today, before any change)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ pass |
| `npm run build` (`next build`, Turbopack) | ✅ pass — 17 static pages, 4 room pages pre-rendered, proxy detected. Used `.env.local` (so room pages queried Supabase availability at build time, read-only). |
| `npm run lint` | ❌ **1 error**: `src/components/reveal.tsx:25` `react-hooks/set-state-in-effect` (legacy IntersectionObserver `Reveal`, now used only by `site-footer.tsx`; its Framer-Motion successor `components/motion/reveal.tsx` has the same API and is used everywhere else). **1 warning**: unused `_drop` in `components/pos/order-builder.tsx:55` (PMS code; leave). Note: Next 16 no longer runs ESLint inside `next build`, so this does not block a Netlify build. |
| `npm test` | **Not run.** All 13 suites are Postgres-level tests (`pg` against `DATABASE_URL`, default `localhost:55432`). No local Postgres is listening and the Docker daemon is not running. None of the planned changes touch SQL, migrations or the DB functions these suites cover. |

### 2.11 Netlify compatibility assessment (facts from the official docs, fetched today)

| Topic | What the docs say | Implication |
|---|---|---|
| Adapter | Netlify "automatically detects that you're using Next.js and provisions your site with the most up-to-date adapter" — the OpenNext-based adapter, published as `@netlify/plugin-nextjs` v5 (latest **v5.16.7, 2026-11-13**). Pinning via `[[plugins]]` is "not recommended". | **No package to install, no `[[plugins]]` block.** Zero new dependencies. |
| Next.js version support | "Next.js version 13.5 and later (up to the latest stable version)"; compatibility verified against every stable release. Changelog entries reference Next 16 (`16.1.0+`, `next@16.3.8`), "Node.js Middleware support" (5.13.0) with later "Node middleware/proxy" fixes, and Turbopack build fixes (5.16.7 "copy per-page turbopack manifests"). | Next 16.2.9 + `proxy.ts` + Turbopack is a supported combination. `experimental.viewTransition` is not mentioned (it is a React client feature; low risk — verified in the local build). |
| Features | Full support listed for App Router, SSR, ISR, SSG, RSC, Server Actions, Route Handlers, Image Optimization (served via Netlify Image CDN), redirects/rewrites, middleware (via edge functions). Limitations: "Headers and Redirects are evaluated after middleware"; Next rewrites can't target `public/` files; Node middleware can't use C++ addons or the filesystem (our proxy uses neither). | Everything this site uses is supported. |
| Build settings | Netlify's suggested values for Next.js are build command `next build` and publish directory `.next`. `netlify.toml` settings override the dashboard. | `netlify.toml` will carry `command = "npm run build"`, `publish = ".next"`. Dashboard left at defaults → no conflicting config. |
| Node | Current build image: Ubuntu 24.04; **default Node 24**; precedence `.nvmrc` → `.node-version` → `NODE_VERSION`. npm matches the Node version. With only `package-lock.json` present Netlify runs `npm install`. | Pin `NODE_VERSION = "24"` in `netlify.toml` (the version the build is verified on locally; satisfies Next's `>=20.9`). No `.nvmrc` so local tooling is untouched. |
| Request chain | Order: edge functions → caches → image CDN → **serverless functions → redirects** → static files. "Unless you enable [preferStatic], any matching function is always invoked." | A `netlify.toml` redirect **cannot** reliably block a route the Next.js function handles. Pausing must happen **in the app** (it does, §4.2). |
| Limits | No per-deploy file limit; 54,000 files per directory. | 537 max per directory here — fine. |
| Base directory | The Next app is the repo root (`package.json` at the worktree root). | No `base` setting; not a monorepo. |

### 2.12 Risks and blockers

| # | Risk / blocker | Severity | Mitigation |
|---|---|---|---|
| R1 | `SITE.url` is a placeholder domain → wrong canonical/sitemap/OG URLs | High (SEO) | fixed in §4.4 |
| R2 | Netlify import pre-selects GitHub default branch `main` | Resolved | `main` is fast-forwarded to the redesign before the site is created; verify the first deploy log builds the expected commit |
| R3 | Lint error blocks the "lint passes" readiness gate | Low | §4.7 |
| R4 | Deploy Previews default to "on" for pull requests → a future PR from `feat/booking-gateway` could get built/previewed on this site with no env vars | Medium | turn off Deploy Previews (or restrict) in §6.1; the pause flag makes such a build harmless anyway |
| R5 | `/rooms/[type]` keeps `revalidate = 300` (ISR) even though it will carry no live data while paused | Low | harmless; leave (removing it would change rendering mode for no benefit) |
| R6 | Proxy still runs on every non-asset request even when it does nothing | Low | with D1-A it returns `NextResponse.next()` immediately — no Supabase round-trip |
| R7 | HSTS header: once sent, browsers insist on HTTPS for the domain | Low | only sent over HTTPS (Netlify provisions the cert); no `preload`, no `includeSubDomains` |
| R8 | Desktop scroll background fetches 537 frames (26 MB) per visit on capable desktops | Medium (bandwidth) | existing behaviour, by design in the component; optional longer `Cache-Control` for the frame directories (D5) |
| R9 | Content accuracy flagged in `docs/Roadmap.md` §1: Deluxe/Premium copy says "Attached bathroom" while the property's live FAQ reportedly says both private rooms lack attached washrooms | Medium (business) | **Not changing copy.** Please confirm the room facts before launch; the fix is a one-word edit in `src/lib/site.ts`. |
| R10 | DB test suites cannot be run on this machine right now | Low | changes do not touch SQL; can run `npm test` later with the local stack (`supabase start` / Docker) |
| B1 | No Netlify site exists yet; Netlify CLI not installed; GitHub App not installed | Blocker for Stage F | manual steps in §6 (you do them in the browser, or authorize me to install `netlify-cli` and run them) |
| B2 | Registrar / DNS host for `thebackpackerstory.in` unknown | Blocker for DNS | D2 |

### 2.13 Information that is missing (reported, not invented)

- Social media handles (none in code or docs).
- Property videos (none in repo).
- A brand favicon / logo file (stock Next favicon is in place).
- Confirmation of room facts (R9) and the exact domain spelling (§2.7).
- Where DNS for `thebackpackerstory.in` is hosted and whether you are willing to change name servers (D2).

---

## 3. Decisions needed before implementation

| # | Decision | Options | My recommendation |
|---|---|---|---|
| **D1** | Staff portal (`/login`, `/pos/*`, `/stays/*`, `/reception`) and `/api/channel/*` on the public deployment | **A)** Off via `STAFF_PORTAL_ENABLED` (404 on Netlify; works locally with the flag in `.env.local`). → **zero env vars on Netlify, no service-role key in hosting.** **B)** Keep reachable → Netlify needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (+ `CHANNEL_SYNC_SECRET` if used). | **A** |
| **D2** | Primary domain and DNS hosting | **A)** Delegate DNS to **Netlify DNS** (change name servers at the registrar) → apex `https://thebackpackerstory.in` is primary, `www` redirects to it. **B)** Keep DNS at the registrar (external DNS) → Netlify "strongly recommends" making **`www`** primary; apex redirects to `www`; canonical becomes `https://www.thebackpackerstory.in`. **C)** External DNS with apex primary (A record / ALIAS) — works, Netlify advises against it for routing performance. | **A** if you can change name servers; otherwise **B**. `SITE.url` follows this choice. |
| **D3** | Social-preview (Open Graph) image | **A)** Derive `public/og.jpg` (1200×630, <300 KB for WhatsApp previews) from an existing property photo — I'd use the rooftop-at-dusk photo (`photo-11.jpg`). **B)** Skip for now. | **A** — this site will mostly be shared over WhatsApp. |
| **D4** | What `/book` does while paused | **A)** Temporary (307) redirect to the contact section `/#visit`. **B)** 404. | **A** — friendlier for any shared link. |
| **D5** | Optional clean-ups (none required for launch) | ☐ delete unreferenced `public/scroll/` (27 MB, 300 files) · ☐ delete the five create-next-app SVGs · ☐ replace the stock favicon (needs a brand asset from you) · ☐ 7-day `Cache-Control` for the frame directories · ☐ sticky mobile WhatsApp button | Skip all for this launch unless you want them; each is reversible. |

Also please confirm: the domain spelling **`thebackpackerstory.in`** (versus the existing `backpackerstorey.in`).

---

## 4. Stage B — implementation plan (exact files and changes)

Everything below assumes D1-A, D2-A, D3-A, D4-A; the alternatives are noted inline.

### 4.1 New: `src/lib/launch.ts` — the two switches

```ts
/**
 * Launch switches for the portfolio release (2026-11).
 *
 * BOOKING_PAUSED — the public booking engine (/book, /booking/[code], the
 * availability calendar, POST /api/book) is paused; every booking CTA becomes a
 * WhatsApp enquiry. Flip to `false` to restore the original flow (the host then
 * needs the Supabase env vars). Nothing was deleted.
 *
 * STAFF_PORTAL_ENABLED — /login, /pos, /stays, /reception and /api/channel/*
 * exist only where this server-side env var is "true" (local dev). It is unset
 * on the public Netlify deployment, so those routes are 404 there.
 */
export const BOOKING_PAUSED: boolean = true;
export const STAFF_PORTAL_ENABLED = process.env.STAFF_PORTAL_ENABLED === "true";
```

`BOOKING_PAUSED` is a code constant on purpose: it must be readable in client components (the header) and must not be re-enabled by a dashboard variable by accident. Un-pausing is a one-line commit.

### 4.2 Booking pause (CTAs → WhatsApp, pages, API)

| File | Change |
|---|---|
| `src/lib/site.ts` | Add a tiny helper next to `SITE`: `whatsappEnquiryLink(message?)` → `https://wa.me/<digits of SITE.whatsapp>?text=<encoded message>`, default message = the footer's existing text "Hi Backpackers Storey! I'd like to ask about a booking." Also fix `SITE.url` (§4.4). |
| `src/components/booking-button.tsx` | When `BOOKING_PAUSED`: render `<a href={whatsappEnquiryLink(msg)} target="_blank" rel="noopener noreferrer">Enquire on WhatsApp <MessageCircle/></a>` with the same variant styles; `msg` is room-specific when `type` is given ("…I'd like to ask about the Deluxe Room."). When not paused: unchanged `<Link href="/book">`. Call sites (header, footer, hero, final CTA, rooms pages) stay untouched — their "Book a bed" labels come back automatically when un-paused. |
| `src/components/site-footer.tsx` | Use the shared `whatsappEnquiryLink()` instead of its local `waLink` (same URL, one source of truth). Switch `Reveal` import to `@/components/motion/reveal` (§4.7). |
| `src/components/marketing/rooms-showcase.tsx` | Paused copy: "Rates and availability: message us on WhatsApp." (original string kept in a ternary). |
| `src/components/marketing/room-journey-card.tsx` | Paused copy: "Ask for rates on WhatsApp". |
| `src/app/(marketing)/rooms/page.tsx` | Paused copy: "Message us on WhatsApp for rates and availability." CTA label handled by `BookingButton`. |
| `src/app/(marketing)/rooms/[type]/page.tsx` | When paused: skip the Supabase availability fetch and do not render the "When you can stay" calendar section. Room content, photos, features, "or call" link unchanged. Add canonical (§4.4). |
| `src/app/(marketing)/book/page.tsx` | First line of the component: `if (BOOKING_PAUSED) redirect("/#visit");` (D4-A; D4-B would be `notFound()`). No availability fetch happens when paused. |
| `src/app/(marketing)/booking/[code]/page.tsx` | `if (BOOKING_PAUSED) notFound();` — guest booking management is not exposed. |
| `src/app/api/book/route.ts` | First lines of `POST`: `if (BOOKING_PAUSED) return json({ ok: false, error: "Online booking is paused. Please WhatsApp us." }, 503);` — returns before the body is read and before any DB client is created. Everything else untouched. |
| `src/lib/booking/lookup.ts` | Same early return inside the server action (belt and braces: `{ ok:false, error: "Online booking is paused." }`). |
| `src/app/robots.ts` | `rules: [{ userAgent: "*", allow: "/", disallow: ["/book", "/booking/", "/api/", "/login", "/pos", "/stays", "/reception"] }]`. |

Not touched: `components/booking/*` (widget, calendar, lookup UI), `lib/booking/{availability,notify,types}.ts`, `lib/dates.ts`, `lib/money.ts`, `supabase/**`, `tests/**`.

### 4.3 Staff portal off on the public deployment (D1-A)

| File | Change |
|---|---|
| `src/app/(portal)/layout.tsx` | `if (!STAFF_PORTAL_ENABLED) notFound();` before `requireUser()`. |
| `src/app/(reception)/layout.tsx` | same, before `requireStaff()`. |
| `src/app/login/page.tsx` | same (page is static → becomes a 404 at build time when the var is unset). |
| `src/app/(portal)/stays/arrivals/form-c/route.ts` | route handlers bypass layouts → `if (!STAFF_PORTAL_ENABLED) return new Response(null, { status: 404 });` first line of `GET`. |
| `src/app/api/channel/sync/route.ts`, `src/app/api/channel/webhook/route.ts` | same 404 guard at the top of `POST` (they already fail closed; this makes the public site answer 404 instead of 401/404-with-DB-lookup). |
| `src/proxy.ts` | `if (!STAFF_PORTAL_ENABLED) return NextResponse.next();` before `updateSession(request)` → no Supabase session work and no `/login` redirects on the public site. Matcher unchanged. |
| `.env.example` | document `STAFF_PORTAL_ENABLED=true  # local development only; leave unset on the public Netlify deployment`. |
| `.env.local` (yours, git-ignored) | **I will not edit it.** Add `STAFF_PORTAL_ENABLED=true` yourself to keep using the portal locally (or tell me to add that one line). |

If you choose **D1-B** instead: none of the above; Netlify gets the three Supabase variables (§6.2) and the portal is reachable at the public domain exactly as it is locally.

### 4.4 Domain, canonical URLs, metadata

| File | Change |
|---|---|
| `src/lib/site.ts` | `url: "https://thebackpackerstory.in"` (D2-A/C) or `"https://www.thebackpackerstory.in"` (D2-B). Drives `metadataBase`, sitemap and robots. |
| `src/app/(marketing)/page.tsx` | `export const metadata: Metadata = { alternates: { canonical: "/" } }`. |
| `src/app/(marketing)/rooms/page.tsx` | add `alternates: { canonical: "/rooms" }` to the existing metadata. |
| `src/app/(marketing)/rooms/[type]/page.tsx` | `generateMetadata` adds `alternates: { canonical: "/rooms/" + room.slug }`. |
| `src/app/layout.tsx` | D3-A: `openGraph.images: [{ url: "/og.jpg", width: 1200, height: 630, alt: <photo alt> }]` and `twitter.images: ["/og.jpg"]`. |
| `public/og.jpg` (new, D3-A) | 1200×630 crop of `public/photos/hero-cafe.jpg` (the only landscape photo) made with macOS `sips`; 264 KB. No new text or graphics — just the property's own photo. |

### 4.5 Security headers — `next.config.ts`

Added via Next's own `headers()` so they apply uniformly to static, ISR and dynamic responses through the adapter (Netlify-level `[[headers]]` are not guaranteed on function-served responses, and the docs note Next headers are supported, evaluated after the proxy).

```ts
const nextConfig: NextConfig = {
  experimental: { viewTransition: true },   // unchanged
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },       // we embed Google Maps; nobody embeds us
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Strict-Transport-Security", value: "max-age=31536000" }, // no preload, no includeSubDomains
      ],
    }];
  },
};
```

No Content-Security-Policy in this release: Tailwind/Framer inline styles, the WebGL scene and the Maps iframe would need a carefully tested policy; a broken CSP is worse than none for a launch. Can be added later.

### 4.6 New: `netlify.toml` (repo root)

```toml
# Backpackers Storey — portfolio site (Next.js 16, App Router).
# Netlify detects Next.js and provisions its OpenNext-based adapter automatically;
# nothing to install or pin here. Values in this file override the dashboard,
# so the dashboard build settings are left at their defaults.
[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  # Node major the build is verified on locally (v24.x); Next 16 requires >= 20.9.
  NODE_VERSION = "24"
```

Deliberately **not** included: `[[plugins]]` (auto-provisioned; pinning discouraged), `base` (repo root is the app), `[[redirects]]` (functions take precedence over redirects, so pausing lives in the app), `[[headers]]` (in `next.config.ts` instead), any env values.

### 4.7 Lint fix

`site-footer.tsx` is the last importer of the legacy `src/components/reveal.tsx` (the one with the `set-state-in-effect` error). Its successor `src/components/motion/reveal.tsx` documents "Same API … call sites migrate with just an import-path change; the legacy component is retired once nothing imports it." So: change the footer's import path and delete the legacy `src/components/reveal.tsx`. This is marketing-only code, not booking/PMS code. The `_drop` warning in `pos/order-builder.tsx` is PMS code and is left alone (warnings don't fail lint).

### 4.8 Documentation

- `docs/Netlify_deploy.md` (new, written in Stage E): the operational runbook — branch, build settings, env vars, domain/DNS records, HTTPS, how to un-pause booking, how to bring the portal up on a separate host.
- `README.md`: replace the create-next-app "Deploy on Vercel" boilerplate paragraph with a two-line pointer to `docs/Netlify_deploy.md`. (Optional; say if you'd rather I leave README untouched.)

### 4.9 Explicitly NOT changed

`src/lib/{booking,channel,inventory,pos,reception,stays,supabase}/**` (except the two one-line guards in `lookup.ts` and none in `supabase/*`), `src/components/{booking,pos,portal,reception,stays}/**`, `src/app/api/book/route.ts` beyond the early return, `supabase/**` (37 migrations, config), `tests/**`, `scripts/**`, `.github/**`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, the design system (`globals.css`, motion components), the scroll sequence, the WebGL scene, all photos, all copy except the four "booking page" sentences listed in §4.2. The `feat/booking-gateway` branch and the `backpackers-storey` worktree: untouched.

**Expected diff size:** ~14 files edited, 3 files added (`launch.ts`, `netlify.toml`, `og.jpg`, plus the deploy doc), 1 legacy component removed.

---

## 5. Stage D — local verification I will run after implementing

1. `npm run lint` → 0 errors. `npx tsc --noEmit` → pass. `npm run build` → pass; confirm the route table matches §2.3 and that `/login` no longer appears as a page when `STAFF_PORTAL_ENABLED` is unset (I'll build once with the var unset to mirror Netlify, using a temporary env override on the command line, not by editing `.env.local`).
2. `npm start` and a status/headers matrix with `curl`:
   `/` 200 · `/rooms` 200 · `/rooms/dorm|deluxe|premium|family` 200 · `/book` 307→`/#visit` · `/booking/ABC123` 404 · `POST /api/book` 503 with the pause JSON · `/login`, `/pos`, `/stays`, `/reception` 404 · `POST /api/channel/sync|webhook` 404 · `/sitemap.xml` lists exactly 6 URLs on the launch domain · `/robots.txt` has the disallow rules · security headers present on `/` and `/rooms/dorm` · `/photos/hero-cafe.jpg`, `/scroll-interpolated/desktop/frame-001.webp`, `/scroll-spike/mobile/frame-001.webp`, `/textures/moon_1024.jpg` 200.
3. Grep the built HTML for `href="/book`, `zotel`, "booking page" → none on public pages; grep `.next/static` for `SUPABASE_SERVICE_ROLE` → none.
4. Open-graph/canonical check on each public page (`<link rel="canonical">`, `og:image`, `og:url`).
5. Browser pass at phone (390px), tablet (820px) and desktop (1440px): navigation, mobile menu, WhatsApp CTAs open `wa.me` with the right message, phone links, map embed + directions, gallery lightbox, rooms fan, scroll sequence, moon scene; no console errors. If a browser tool is available in this session I'll do it myself with screenshots; otherwise I'll give you the checklist.
6. `npm test` only if a local Postgres with the migration chain is available (not today; see §2.10). The changes do not touch what those suites test.

---

## 6. Stage E — Netlify preparation (what I prepare; what you do in the browser)

### 6.1 GitHub → Netlify connection (manual steps, in order)

1. **Push first** (done at implementation): the implementation commits on `redesign/marketing` → `origin/redesign/marketing`, and `main` fast-forwarded to the same commit → `origin/main`.
2. Netlify dashboard → **Add new project → Import an existing project → GitHub**.
3. Install the **Netlify GitHub App** on the `Whatever-Piyush` account and, when asked for repository access, choose **"Only select repositories" → `TheBackpackStorey`** (the docs confirm access can be limited to specific repositories and changed later at github.com/settings/installations).
4. Select the repository. In the configure step confirm **Branch to deploy = `main`** (the GitHub default, now identical to `redesign/marketing`). Build command and publish directory will be read from `netlify.toml`; leave the dashboard fields empty/default so nothing conflicts. Base directory: empty.
5. Environment variables: **none** (D1-A). Do not add the Supabase or Cashfree keys.
6. Deploy. The first build log should show the Next.js adapter being provisioned and `▲ Next.js 16.2.9 (Turbopack)`.
7. After it is live on the temporary `<site-name>.netlify.app` URL, run the §5 curl matrix against it (I can do this read-only once you give me the URL).
8. **Project configuration → Build & deploy → Continuous deployment → Branches and deploy contexts → Configure**: confirm Production branch = `main`; set **Branch deploys = None**; set **Deploy Previews = None** so nothing from `feat/booking-gateway` (or any other branch) ever builds on this site.

### 6.2 Environment variables on Netlify

| Variable | D1-A (recommended) | D1-B (portal reachable) | Scope / notes |
|---|---|---|---|
| `NODE_VERSION` | set in `netlify.toml` (24) | same | build only |
| `NEXT_PUBLIC_SUPABASE_URL` | not set | required | public; inlined at build — set **before** the first build |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | not set | required | public |
| `SUPABASE_SERVICE_ROLE_KEY` | not set | required | **secret**; mark as secret in Netlify; server-side only |
| `STAFF_PORTAL_ENABLED` | **not set** | `true` | server-side |
| `CHANNEL_SYNC_SECRET` | not set | only if the sync cron is used | secret |
| `RESEND_API_KEY`, `BOOKING_FROM_EMAIL`, `CASHFREE_*`, `DATABASE_URL`, `CHANNEL_MOCK_SECRET` | never | never | not needed by the portfolio deployment |

I will not type any secret value anywhere; values stay in your password manager / `.env.local`.

### 6.3 Custom domain, DNS, HTTPS (after the site exists; no DNS change without your approval)

**Add the domain:** Netlify → Domain management → Add a domain → `thebackpackerstory.in`. Netlify adds both `thebackpackerstory.in` and `www.thebackpackerstory.in` and redirects the non-primary one to the primary automatically (docs: redirect is automatic between apex and `www` in both directions).

**D2-A — Netlify DNS (recommended):** at the registrar, replace the name servers with the four `dnsN.p0N.nsone.net` servers that Netlify shows under Team → DNS → `thebackpackerstory.in` → Name servers (the exact list is only shown in the UI; I will not guess it). Primary domain = apex. Propagation up to 24 h.

**D2-B / D2-C — external DNS (records quoted from Netlify's external-DNS doc):**

| Host | Type | Value | Note |
|---|---|---|---|
| `www` | CNAME | `<site-name>.netlify.app` | exact target shown in Netlify's "Set up Netlify DNS / external DNS" panel after the site is created |
| `@` (apex) | ALIAS / ANAME / flattened CNAME | `apex-loadbalancer.netlify.com` | preferred, if the DNS provider supports it |
| `@` (apex) | A | `75.2.60.5` | fallback when ALIAS-type records are unavailable (Netlify's documented load-balancer address; verify against the value shown in your dashboard before use) |

With external DNS Netlify strongly recommends **`www` as the primary domain** (D2-B). `SITE.url` and the canonical URLs must match whichever is primary.

**HTTPS:** Netlify provisions a Let's Encrypt certificate automatically once DNS resolves to Netlify, and renews it. After issuance, confirm in Domain management → HTTPS that the certificate covers both hostnames and that HTTP→HTTPS forcing is on; then the HSTS header from §4.5 is in effect. Allow up to 24 h for DNS + certificate.

**Pre-cutover smoke test:** everything in §5 against `https://<site-name>.netlify.app` before touching DNS; after cutover, repeat against both `https://thebackpackerstory.in` and `https://www.thebackpackerstory.in` and confirm one redirects to the other with a 301.

---

## 7. Stage F — waits for your explicit authorization

- `git commit` on `redesign/marketing` and `git push origin redesign/marketing`.
- Creating the Netlify site / installing the GitHub App (you, in the browser — or authorize me to install `netlify-cli` and link the site from this machine).
- Adding the custom domain and any name-server or DNS record change at the registrar.
- Triggering the production deploy and declaring it live. I will only report "deployed" after Netlify itself shows a successful production deploy and the smoke test passes.

---

## 8. Reversibility

- **Un-pause booking:** set `BOOKING_PAUSED = false` in `src/lib/launch.ts`, add the Supabase env vars to the host, deploy. Every CTA, page, calendar, and `POST /api/book` returns exactly as before; the original copy strings are still in the code.
- **Bring the portal up:** set `STAFF_PORTAL_ENABLED=true` plus the Supabase variables on whichever host runs it (this one or a separate Netlify site built from the same branch).
- **Booking gateway work:** untouched on `feat/booking-gateway`; continue development there as before.

---

## 9. Appendix

### 9.1 Files inspected during the audit

Root: `package.json`, `package-lock.json` (presence/size only), `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `.gitignore`, `.env.example`, `.env.local` + `.env.development.local` (**variable names only**), `README.md`, `AGENTS.md`, `CLAUDE.md`, `Website.md`, `codebase.md`, `photos-source-map.txt`, `.github/workflows/backup.yml`.
Docs: `docs/Roadmap.md`, `docs/Runbook.md`, `docs/Security_check.md` (first 200 lines), `supabase/README.md`, `supabase/migrations/` (listing only).
App: `src/app/layout.tsx`, `src/app/(marketing)/{layout,page,rooms/page,rooms/[type]/page,book/page,booking/[code]/page}.tsx`, `src/app/not-found.tsx`, `src/app/sitemap.ts`, `src/app/robots.ts`, `src/app/login/page.tsx`, `src/app/(portal)/layout.tsx`, `src/app/(portal)/stays/arrivals/form-c/route.ts`, `src/app/(reception)/layout.tsx`, `src/app/api/book/route.ts`, `src/app/api/channel/{sync,webhook}/route.ts`, `src/proxy.ts`.
Lib: `src/lib/site.ts`, `src/lib/auth.ts`, `src/lib/booking/{availability,lookup,notify,types}.ts`, `src/lib/supabase/{config,public,client,server,admin,proxy-session}.ts`, `src/lib/reception/staff.ts`.
Components: `booking-button.tsx`, `site-header.tsx`, `site-footer.tsx`, `reveal.tsx`, `room-card.tsx`, `motion/reveal.tsx`, `marketing/{hero,intro,rooms-showcase,rooms-fan (head),room-journey-card,cafe,experiences,around-bir,amenities,gallery,final-cta,atmosphere,scroll-sequence (head),lunar-scene (head),photo-stack (head)}.tsx`.
Tests: headers of `tests/public.test.mts`, `tests/booking-api.test.mts`, `tests/grants.test.mts`.
Assets: full listing of `public/` with sizes.
Next 16 bundled docs (`node_modules/next/dist/docs`): `getting-started/17-deploying.md`, `file-conventions/proxy.md`, `upgrading/version-16.md`.
Backend worktree (read-only): `git branch`, `git status`, `git log -5`, `git branch -a`.

### 9.2 External documentation consulted (2026-11-16)

- Netlify — Next.js on Netlify overview: https://docs.netlify.com/frameworks/next-js/overview/ and https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/
- OpenNext — Netlify adapter: https://opennext.js.org/netlify · repo/changelog/releases: https://github.com/opennextjs/opennextjs-netlify
- Netlify — available software at build time (Ubuntu 24.04, Node 24 default): https://docs.netlify.com/build/configure-builds/available-software-at-build-time/
- Netlify — manage dependencies (Node pinning, package managers): https://docs.netlify.com/build/configure-builds/manage-dependencies/
- Netlify — file-based configuration (`netlify.toml`): https://docs.netlify.com/build/configure-builds/file-based-configuration/
- Netlify — request chain (functions before redirects): https://docs.netlify.com/resources/troubleshooting/request-chain
- Netlify — external DNS: https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/ · Netlify name servers: https://docs.netlify.com/manage/domains/configure-domains/netlify-name-servers/ · primary domain & apex/www redirect: https://docs.netlify.com/manage/domains/manage-domains/manage-multiple-domains/ · HTTPS: https://docs.netlify.com/manage/domains/secure-domains-with-https/https-ssl/
- Netlify — deploys, production branch, branch deploys: https://docs.netlify.com/deploy/deploy-overview/ · repo permissions / GitHub App: https://docs.netlify.com/build/git-workflows/repo-permissions-linking/ · build environment variables: https://docs.netlify.com/build/configure-builds/environment-variables/
