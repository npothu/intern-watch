# Local web development

This guide runs the Next.js web app on `http://localhost:3000` against a Convex development deployment.
It is the recommended local setup because the Gmail OAuth callback and Pub/Sub push endpoint remain publicly reachable on `https://<deployment>.convex.site`.

The repository has three separate runtime environments:

| Runtime | Local development location | What it contains |
| --- | --- | --- |
| Next.js | `web/.env.local` | Clerk keys, Convex URLs, the tracker secret, and the Clerk-email mapping |
| Convex | Development deployment environment variables | Google OAuth credentials, encryption key, Pub/Sub configuration, and the tracker secret |
| Python watcher | Root `.env` | Watcher, notification, and optional standalone CLI values |

Setting a value in one environment does not copy it into either of the others.

## Prerequisites

- Node.js and npm
- A Convex account with access to the project's development deployment
- A [Clerk development instance](https://clerk.com/docs/guides/development/managing-environments)
- The operator-managed Google Cloud configuration from [mail-sync.md](mail-sync.md) if you need to test Gmail sync

Individual app users do not create Google OAuth clients or enter client secrets.
The deployment operator configures one Web application OAuth client for the whole deployment, and each user only grants access to their own Gmail account.

## 1. Install dependencies

Run these commands from the repository root:

```powershell
npm install
npm --prefix web install
```

## 2. Connect the Convex development deployment

Run this once from the repository root:

```powershell
npx convex dev --once --typecheck disable
```

On a new checkout, Convex asks you to sign in and select or create a development deployment.
The command writes the selected deployment information to the gitignored root `.env.local`, then deploys the functions and schema under `convex/`.

Use the development deployment for local work.
`npx convex deploy` targets production and is not a local-development command.

## 3. Configure the Convex development environment

Open the [Convex dashboard](https://dashboard.convex.dev), select the development deployment shown in root `.env.local`, and open Settings -> Environment Variables.
Set these values:

| Variable | Required for | Notes |
| --- | --- | --- |
| `TRACKER_SECRET` | All authenticated tracker writes | Use a strong random value |
| `CREDENTIALS_KEY` | Encrypted per-user credentials | Exactly 32 random bytes encoded as base64 |
| `GMAIL_CLIENT_ID` | Gmail connection | The shared Google Web application client ID |
| `GMAIL_CLIENT_SECRET` | Gmail connection | The shared Google Web application client secret |
| `MAIL_PUBSUB_TOPIC` | Gmail push sync | Format: `projects/<project-id>/topics/<topic>` |
| `MAIL_PUSH_TOKEN` | Gmail push sync | Use a strong random value |
| `GEMINI_API_KEY` | Optional server-side LLM fallback | Omit if you do not want the fallback |

Convex environment variables are deployment-specific.
Setting a value on development does not set it on production, and setting it on production does not set it on development.

Never replace an existing `CREDENTIALS_KEY` unless you intentionally want to invalidate all credentials encrypted by that deployment.
If you create a key for this checkout, append the deployment name and key to the local `secrets/deployment-keys.log` before setting it.
That file is excluded through `.git/info/exclude` in the maintained checkout and must never be committed.

For a brand-new development deployment, this PowerShell sequence creates the key, appends it before use, and passes it to Convex without putting the value in shell history:

```powershell
New-Item -ItemType Directory -Force secrets | Out-Null
$deploymentLabel = "development:<deployment-name>"
$credentialsKey = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
Add-Content -LiteralPath secrets/deployment-keys.log -Value "$(Get-Date -Format o) $deploymentLabel CREDENTIALS_KEY=$credentialsKey"
$credentialsKey | npx convex env set CREDENTIALS_KEY
Remove-Variable credentialsKey
```

Do not run that sequence for a deployment that already has encrypted credential rows.
Use `Add-Content` for later entries and never rewrite or truncate the log.

You can inspect the deployment's current environment:

```powershell
npx convex env list
```

The command prints secret values, so do not paste its output into an issue, chat, commit, or log.
The same commands with `--prod` inspect or change production instead.

## 4. Configure Clerk and the local web server

Copy the example file:

```powershell
Copy-Item web/.env.example web/.env.local
```

Fill in `web/.env.local`:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up

CONVEX_URL=https://<development-deployment>.convex.cloud
CONVEX_SITE_URL=https://<development-deployment>.convex.site
CONVEX_SECRET=<the development deployment's TRACKER_SECRET>

TRACKER_USER_MAP={"your-clerk-email@example.com":"example"}
APP_ORIGIN=http://localhost:3000
```

Use keys from a Clerk development instance, which begin with `pk_test_` and `sk_test_`.
The email in `TRACKER_USER_MAP` must be lowercase and must match the email you use to sign in through Clerk.
The mapped value is the tracker user key from the corresponding file under `users/`.

`CONVEX_URL` and `CONVEX_SITE_URL` are different origins:

- `CONVEX_URL` ends in `.convex.cloud` and is used for Convex queries and mutations.
- `CONVEX_SITE_URL` ends in `.convex.site` and hosts the Gmail OAuth callback and push endpoint.

## 5. Register the development Google callback

In the shared [Google Cloud Web application OAuth client](https://developers.google.com/identity/protocols/oauth2/web-server), add this exact authorized redirect URI:

```text
https://<development-deployment>.convex.site/gmail/callback
```

The scheme, hostname, path, case, and trailing slash must match exactly.
The callback is not `localhost` because Convex exchanges and encrypts the Google token on the server.
After that succeeds, the signed OAuth state returns the browser to `APP_ORIGIN`, which is `http://localhost:3000` here.

If the Google consent screen is still in Testing status, add the Gmail account you will use as a test user.
Complete the Gmail API and Pub/Sub setup in [mail-sync.md](mail-sync.md) before testing push synchronization.

## 6. Run the app

For ongoing development, run Convex and Next.js together from the repository root:

```powershell
npx convex dev --start "npm --prefix web run dev" --typecheck disable
```

Then open [http://localhost:3000](http://localhost:3000), sign in through Clerk, and visit Settings -> Connections -> Google - Gmail.

If another process is already watching and deploying Convex, run only the frontend:

```powershell
npm --prefix web run dev
```

## 7. Verify the Gmail connection

1. Select **Continue with Google**.
2. Sign in to the Gmail account whose recruiter messages should be synchronized.
3. Approve the read-only Gmail permission.
4. Confirm that Google returns through the Convex callback and then redirects to `http://localhost:3000/settings/connections/google`.
5. Confirm that the page reports the connected Gmail address.

## Common failures

### Localhost redirects to Clerk sign-in

This is expected before a Clerk session exists.
Sign in with the Clerk development instance and use an email present in `TRACKER_USER_MAP`.

### The account is not provisioned

Add the lowercase Clerk email to `TRACKER_USER_MAP` and restart the Next.js process after changing `web/.env.local`.

### Gmail connection is unavailable

Check that all five Gmail and credential variables are present on the Convex development deployment: `CREDENTIALS_KEY`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `MAIL_PUBSUB_TOPIC`, and `MAIL_PUSH_TOKEN`.
These do not belong in `web/.env.local`.

### Google reports `redirect_uri_mismatch`

Compare Google's authorized redirect URI with `<CONVEX_SITE_URL>/gmail/callback` character for character.
Make sure you changed the Web application client whose ID is stored as `GMAIL_CLIENT_ID` on the development deployment.

### Google succeeds but returns to the wrong web host

Set `APP_ORIGIN=http://localhost:3000` in `web/.env.local`, restart Next.js, and try again.

### The callback returns a Convex server error

Inspect the development deployment logs in the Convex dashboard.
The most common causes are a missing deployment variable, a Google client ID and secret from different clients, or a stale `CREDENTIALS_KEY` that cannot decrypt existing rows.

## Development and production commands

| Goal | Command |
| --- | --- |
| Deploy Convex once to development | `npx convex dev --once --typecheck disable` |
| Watch and deploy Convex development changes | `npx convex dev --typecheck disable` |
| Run the local Next.js frontend | `npm --prefix web run dev` |
| Deploy Convex to production | `npx convex deploy --yes --typecheck disable` |

The production web app deploys through the repository's Vercel Git integration when `main` is pushed.
Development and production Convex deployments require separate environment-variable values and separate Google callback URLs.
