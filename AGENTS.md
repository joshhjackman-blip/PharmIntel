# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

Mineral Map is a Next.js 14 (App Router) application for off-market mineral rights prospecting in Texas counties. It uses npm as the package manager (`package-lock.json`).

### Running the Application

- **Dev server**: `npm run dev` (serves on http://localhost:3000)
- **Build**: `npm run build`
- **Lint**: `npm run lint`

### Public Pages (no auth required)

The middleware allows unauthenticated access to:
- `/landing` — marketing landing page
- `/pricing` — subscription pricing tiers
- `/auth` — login/signup form
- `/demo` — interactive demo with Mapbox map

All other routes redirect to `/landing` if not authenticated, or to `/pricing` if authenticated without an active subscription.

### External Services

This app depends entirely on remote services (no local database):
- **Supabase** (PostgreSQL, Auth, Storage) — required for auth and all data operations
- **Mapbox** — required for map rendering (demo page + main app)
- **Stripe** — required for subscription gating; without valid Stripe keys, authenticated users are redirected to `/pricing`

Without valid Supabase credentials, the auth page will show errors on form submission but still renders. The landing and pricing pages work fully without any credentials.

### Environment Variables

Copy `.env.local.example` and fill in real values. Additional variables not in the example but used in code:
- `NEXT_PUBLIC_MAPBOX_TOKEN` — needed for map rendering
- `TRACERFY_API_KEY` — optional, for skip trace feature
- `BATCHSKIPTRACING_API_KEY` — optional, fallback skip trace

### Known Gotchas

- The `next.config.mjs` sets `output: 'standalone'` and `eslint.ignoreDuringBuilds: true`, so `npm run build` won't fail on lint errors.
- Pre-existing lint errors exist in `app/page.tsx` and `app/demo/page.tsx` (unused variables). These are not regressions.
- The `/methodology` page is not listed as a public route in `middleware.ts`, so it redirects unauthenticated users to `/landing`.
- Large GeoJSON files exist in `data/` and `public/` (up to ~92MB). These are committed to the repo and used for map display.
- Node.js 20.x is required (Next.js 14 compatibility).
