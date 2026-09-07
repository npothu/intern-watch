# Script API

The hosted web app exposes `/api/v1` for scripts that manage matches, applications, inbox actions, resumes, profiles, and settings.
It uses the same Convex operations as the web app.
Changes appear when the app next fetches its data.

## Configure access

API keys belong to one tracker user, such as the `name` in that user's YAML configuration.
They do not need a Clerk session or the shared `CONVEX_SECRET`.
Only the server needs `CONVEX_URL` and `CONVEX_SECRET`.

Generate a key from the repository root:

```sh
node scripts/create-api-key.mjs example ~/.config/intern-watch/script-key.json write
```

The command creates a private file with mode `0600` and refuses to overwrite an existing file.
It prints a configuration entry containing a SHA-256 hash, the tracker user, and the access level.
The key itself stays in the file.
Use `read` instead of `write` for a key that can only use GET and HEAD.

Add the printed entry to the web server's `TRACKER_API_KEYS` environment variable:

```json
[
  {"sha256":"<64-character hash from the command>","user":"example","access":"write"}
]
```

Set this in `web/.env.local` for local use, or in the hosting environment before deploying.
An unset variable disables the API.
Each hash must appear only once.
Multiple keys can belong to the same user.
Remove an entry and restart or redeploy the web server to revoke that key.
Keep this configuration separate for production and previews.

## Make a request

Send `Authorization: Bearer <apiKey>` on every request, including OpenAPI discovery.
Requests with a body must use `Content-Type: application/json`.
The API never accepts a `user` or backend secret in the body or query string.
Unknown body fields and query parameters are rejected.

```sh
export INTERN_WATCH_URL=https://jobs.example.com
export INTERN_WATCH_API_KEY="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).apiKey' ~/.config/intern-watch/script-key.json)"

curl --fail-with-body -sS "$INTERN_WATCH_URL/api/v1/matches" \
  -H "Authorization: Bearer $INTERN_WATCH_API_KEY"

curl --fail-with-body -sS -X PUT "$INTERN_WATCH_URL/api/v1/ticks" \
  -H "Authorization: Bearer $INTERN_WATCH_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"writes":[{"short":"0123456789ab","field":"saved","value":true}]}'
```

Use a real lowercase 12-character `short` key from a match or application.
Marking a match applied creates its application record immediately.
Clearing an applied tick removes the application only if it never progressed beyond its initial applied state.
Status writes preserve application history and can create a missing application.
Due dates and snoozes require an existing application.

JSON successes have the shape `{"data": ...}`.
Errors have the shape `{"error":{"code":"invalid_request","message":"..."}}`.
All responses use `Cache-Control: no-store`.
The API returns whole per-user collections without pagination; query filters are not supported in v1.
Scripts can filter those collections locally.

| HTTP status | Meaning |
| --- | --- |
| 200 | Read or write completed |
| 202 | Ingestion, resume build, or profile mapping accepted; poll for completion |
| 400 | Invalid JSON, fields, or parameters |
| 401 | Missing, invalid, or revoked key |
| 403 | A read-only key attempted a write |
| 404 | Endpoint or required record not found |
| 405 | Unsupported method for this endpoint |
| 409 | Operation cannot proceed in the current state |
| 413 | Request body exceeds 2 MiB |
| 415 | Body is not sent as JSON |
| 429 | Job ingestion rate limit reached |
| 502 | Backend request failed; raw backend errors are withheld |
| 503 | API keys are absent or misconfigured |

Do not retry POST requests blindly after a timeout.
A request may have succeeded even when the response was lost.
Check the relevant state first, especially before starting another resume build or profile import.
PUT requests set explicit values, but profile and preference replacements use the last completed write.
Read the current object before editing it if other scripts or browser sessions may be working on it.

## Endpoints

All paths below are relative to `/api/v1`.
`GET /api/v1` or `GET /api/v1/openapi.json` returns the OpenAPI 3.1 document with methods, input schemas, field limits, and accepted enum values.
The document is built from the same endpoint definitions and validators that handle requests.
GET endpoints also support HEAD.
Browser cookies alone never authorize these endpoints.

| Method | Path | Input or result |
| --- | --- | --- |
| GET | `/me` | `{user}` for the API key |
| GET | `/health` | Watcher and mail health, pending inbox and stuck-build counts |
| GET | `/matches` | Array of matches with current applied, saved and dismissed flags |
| GET | `/ticks` | Array of stored match flags |
| PUT | `/ticks` | `{writes:[{short,field,value}]}`, up to 500; returns `{count}` |
| POST | `/ingests` | `{url}`; returns `{ingestId,short,status}` |
| GET | `/ingests/{id}` | Ingestion record, including status and any error |
| GET | `/applications` | Array of applications with short, status, note, history, snapshot and dates |
| PUT | `/applications/{short}/status` | `{status,note?}`; omitted note means empty string |
| PUT | `/applications/{short}/due-date` | `{dueAt}`, an ISO date or datetime, or null to clear |
| PUT | `/applications/{short}/snooze` | `{snoozedUntil}`, an ISO date or datetime, or null to clear |
| GET | `/inbox` | `{actions,health}` |
| POST | `/inbox/{id}/resolve` | `{short,status}` to resolve, or `{dismiss:true}` to dismiss |
| GET | `/matches/{short}/job-description` | `{text,updatedAt}`, with nulls when unavailable |
| PUT | `/matches/{short}/job-description` | `{jdText}`, up to 20,000 characters |
| GET | `/resumes` | Object keyed by short, containing download URLs and build reports |
| GET | `/resumes/{short}` | `{build,resume}` for polling and downloads |
| POST | `/resumes/{short}/build` | `{}` or refinements described below |
| POST | `/resumes/{short}/restore` | `{}`; swaps current and previous builds |
| DELETE | `/resumes/{short}` | Deletes both kept builds |
| GET | `/profile` | Resume profile as a JSON object, or null |
| PUT | `/profile` | `{profile}`; replaces the profile, maximum 768 KiB |
| POST | `/profile/export` | `{format,variant?,profile?}`; returns file bytes, not a JSON envelope |
| POST | `/profile/suggest-cuts` | `{profile,variant}`; returns proposed cuts and page counts |
| POST | `/profile/import/upload` | `{filename,size}`; returns `{uploadUrl,contentType}` |
| POST | `/profile/import` | `{storageId,filename}`; starts mapping the uploaded file |
| GET | `/profile/import` | Mapping status, preview or error; null when no import exists |
| DELETE | `/profile/import` | Discards the pending upload and mapping |
| POST | `/profile/import/confirm` | `{profile}`; saves the reviewed import with a backup |
| GET | `/preferences` | `{watch,updatedAt,report}` |
| PUT | `/preferences` | `{watch}`; replaces all watcher overrides |
| GET | `/resume-model` | Model choice, shared defaults and usage |
| PUT | `/resume-model` | `{provider,model}`; both null resets the shared default |
| GET | `/connections` | `{credentials,mailbox}`; metadata and health, without secret values |
| PUT | `/connections/{provider}` | `{fields:{apiKey}}`; encrypts and saves an LLM provider key |
| POST | `/connections/{provider}/test` | `{}`; returns `{ok,detail}` from the provider check |
| DELETE | `/connections/{provider}` | Removes the saved LLM provider key |

Tick fields are `applied`, `saved`, and `dismissed`.
Application statuses are `applied`, `oa`, `phone_screen`, `interview`, `offer`, `rejected`, and `withdrawn`.
`ghosted` is computed by the UI and cannot be stored.
LLM providers are `gemini`, `anthropic`, `openai`, and `openrouter`.
A credential test returning `data.ok: false` means the check completed but the provider rejected the credential or could not be reached.

## Resume workflows

A build accepts optional `jdText`, `instructions`, `overrides`, `variant`, and `profileSnapshot`.
`profileSnapshot` is a JSON object, like `profile`, rather than a serialized JSON string.
Overrides are an array of `{entryId?,name,bullets}` with at most 12 entries.
Instructions are limited to 1,000 characters and variant names to 40 characters.
The user must already have a profile and the job must exist in their matches.

After starting a build, poll `/resumes/{short}`.
`build` is `"building"`, `{status:"failed",error}`, or null.
When `build` becomes null, `resume` contains the download URLs and report if a resume exists.
A previous resume can remain available while a rebuild is running or has failed, so check `build` before treating the resume as a new result.
A null build and null resume means no completed resume is available.

Full profile export accepts `format: "pdf"` or `"docx"` and defaults to the `base` variant.
Omit `profile` to export the saved profile.
The response includes `Content-Type` and `Content-Disposition` and contains the file bytes.

```sh
curl --fail-with-body -sS -X POST "$INTERN_WATCH_URL/api/v1/profile/export" \
  -H "Authorization: Bearer $INTERN_WATCH_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"format":"pdf","variant":"base"}' \
  --output resume.pdf
```

For file import, call `/profile/import/upload` with a DOCX, TXT, or Markdown filename and its byte size, at most 5 MiB.
POST the raw file bytes to the returned `uploadUrl` using the returned `contentType`.
Do not send the script API key to the storage URL.
The storage response supplies a `storageId`; pass it with the same filename to `/profile/import`.
Poll that endpoint until `status` is `ready` or `failed`.
Review `preview.profile`, unmapped lines, and semantic warnings before sending the chosen profile to `/profile/import/confirm`.
DELETE `/profile/import` cancels or discards a pending import.
Only one pending import is tracked per user.

Editing the profile JSON covers header, skills, sections, entries, bullets, and saved resume variants.
See [the resume reference](resume.md) and `convex/profile_schema.ts` for profile structure.
Preference blocks follow `convex/watch_types.ts`; the OpenAPI input schema includes their complete shape.
Omitted preference blocks fall back to the user's YAML configuration.

Google OAuth linking remains a browser consent flow in Settings.
Browser-only theme and motion preferences, account sign-in, and deployment administration are outside this API.
This API manages the tracker; it does not submit job applications to employers or send arbitrary email.

## Verification

Install both dependency sets with `npm ci` and `npm ci --prefix web`.
Run `npm test -- web/lib/api` for the API tests, or `npm test` for the complete backend and shared web suite.
API tests send HTTP-shaped requests through the route handlers and real web client to an in-memory Convex backend.
They do not require cloud credentials or write production data.
