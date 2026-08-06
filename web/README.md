# intern-watch web

The hosted, multi-user triage sibling of the local Python webui (`src/webui`).
Next.js (App Router, TypeScript), Tailwind CSS v4, shadcn/ui primitives
re-skinned to the intern-watch "Fern & Paper" identity, Clerk auth, and Convex
data. All data is reached from the server - Convex secrets are never exposed
to the browser.

## Stack

- Next.js 16 (App Router) + React 19, TypeScript
- Tailwind CSS v4 (CSS-first config in `app/globals.css`)
- shadcn/ui (radix base) for primitives: button, dialog, dropdown-menu, select,
  sonner toast, skeleton
- Clerk (middleware protects everything except sign-in/sign-up)
- Convex reached server-side only via `lib/convex.ts` (`CONVEX_URL` +
  `CONVEX_SECRET`), using the same HTTP protocol as the Python `ConvexStore`

## Setup

1. Install dependencies: `npm install`
2. Copy `web/.env.example` to `web/.env.local` and fill in real values.
3. Create a Clerk application at https://dashboard.clerk.com and copy its
   publishable + secret keys into `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` /
   `CLERK_SECRET_KEY`.
4. Set `CONVEX_URL` to your Convex deployment origin and `CONVEX_SECRET` to a
   value matching that deployment's `TRACKER_SECRET` env var (see
   `src/store.py` `ConvexStore`). This web app makes no Convex schema or
   function changes - it shares the deployment with the Python pipeline.
5. Set `TRACKER_USER_MAP` to a JSON object mapping each authorized Clerk email
   to its tracker user key, e.g. `{"you@example.com":"example"}`. Signed-in
   emails not in the map see the "not provisioned" screen.
6. Run `npm run dev` and open the printed URL.

## Env vars

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (public) |
| `CLERK_SECRET_KEY` | Clerk secret key (server only) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `..._SIGN_UP_URL` | Clerk route paths |
| `CONVEX_URL` | Convex deployment origin (server only) |
| `CONVEX_SECRET` | Secret matching the deployment's `TRACKER_SECRET` (server only) |
| `TRACKER_USER_MAP` | JSON email -> tracker user key mapping (server only) |

## Scripts

- `npm run dev` - local dev server
- `npm run build` - production build (must pass with only dummy env values)
- `npm run lint` - ESLint
- `node scripts/shortkey-check.ts` - verifies `lib/shortkey.ts` parity with
  `src/dashboard.py` `short_key()`

## Deploying

Deploy on Vercel with the project's **root directory set to `web/`**. In the
Vercel project environment, set the same variables as `web/.env.example`. The
app is `STORE=convex`: it reads/writes the shared Convex deployment directly
and does not need GitHub access.

## Conventions

- The identity green lives in the `accent` / `accent-ink` theme colors; shadcn
  hover fills use `muted` (chip) instead.
- `lib/convex.ts` and `lib/user.ts` are server-only (`server-only` import) -
  never import them into client components.
- Pages: `/` = matches triage, `/tracker` = applications ledger. Both live in
  the `app/(app)` route group, which is where the auth/provision gate lives.
