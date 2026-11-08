# Renaming a tracker user key (runbook)

Used for the 2026-11 rename of `example` to `nathan`, together with the
repository rename `intern-watch` to `intern-baddie`. The user key is stored in
three places that must change together:

| Where | What holds the key |
|---|---|
| Convex (19 tables) | the `user` field on every per-user row |
| Web host env | `TRACKER_USER_MAP` (email -> key) and each `TRACKER_API_KEYS` entry's `user` |
| Data repo | `users/<key>.yaml` (`name:`), `state/applications.json`, `state/seen.json` |

SHORTs, credentials, resume files and document ids do not change.

## Before the window

1. Merge the data-repo PR that makes the resume callers accept both dashboard titles
   (npothu/autojobfinder#116) **first**: once the code PR is live, every watch run
   retitles the dashboard issue to "intern-baddie matches", which the old callers ignore.
2. Merge the code PR (`convex/migrations.ts`, `convex/maintenance.ts`, the rename) and
   wait for `deploy-convex.yml` to finish. The deploy builds the new
   `oauthNonces.by_user` index before registering functions; nothing else changes
   behaviour until maintenance is switched on.
3. **Back up**: run `backup.yml` and confirm the artifact exists. `deleteUser` is
   permanent, and a Convex restore replaces the whole deployment, so this backup is
   the only undo for the delete.
4. Prepare (do not merge yet) one data-repo commit that:
   - points all five callers (`watch.yml`, `dashboard-write.yml`, `resume.yml`,
     `resume-batch.yml`, `resume-ondemand.yml`) at `npothu/intern-baddie` (GitHub does
     **not** redirect reusable-workflow `uses:` after a repository rename);
   - updates data-repo docs that name the old user or repo (`CLAUDE.md`, `README.md`,
     `docs/APPLICATION-API.md`, `records/agent-kit-rules.md`).
5. Pick a window that avoids the daily mail crons (06:00 and 06:30 UTC) and the
   watch schedule. Pause every jobin / API-key agent.

## Window

1. **Stop writers**
   - Disable the data-repo workflows (`gh workflow disable <name> -R npothu/autojobfinder`
     for watch, dashboard-write, resume, resume-batch, resume-ondemand) and wait until
     `gh run list` shows nothing in progress.
   - `npx convex env set --prod TRACKER_MAINTENANCE 1`. Public queries, mutations and
     actions fail with a maintenance message; Gmail pushes, the OAuth callback and
     file routes return 503 (Pub/Sub redelivers pushes later); the daily mail crons
     skip; direct-request internal writes (mailbox/credential store, push, upload
     tokens) refuse.
   - **Wait 10 minutes** (Convex's maximum action duration) so any request that
     passed its gate just before the switch has finished. Any Gmail-connect flow in
     progress must be restarted afterwards.
2. **Dry runs** (change nothing):
   - `npx convex run --prod migrations:renameUser '{"from":"example","to":"nathan","dryRun":true}'`
   - `npx convex run --prod migrations:deleteUser '{"user":"nathan","dryRun":true}'` (if the
     rename dry run shows rows already under `nathan`)
   - The rename dry run will list collisions with the old test `nathan`; that is
     expected until step 3. `pending` must be empty. **Drain, don't cancel**: let pending builds, imports,
     ingests and syncs finish and re-run the dry run. Cancelling one leaves its status
     row unfinished; if you must cancel, clear that row afterwards (failed build ->
     `markBuildFailed`, import -> discard, ingest -> mark failed) and note that
     cancelling `uploads.expire` skips a blob cleanup.
3. **Delete the stale target** (2026-11: the old `nathan` was test data Nathan asked to discard):
   `npx convex run --prod migrations:deleteUser '{"user":"nathan","dryRun":false,"confirm":"nathan"}'`
   It throws unless every table ends at zero. Then re-run the rename dry run: every
   `before.nathan` count must be 0, and `collisions` and `blockers` must be empty.
4. **Migrate**:
   `npx convex run --prod migrations:renameUser '{"from":"example","to":"nathan","dryRun":false}'`
   It refuses on any blocker and fails loudly if, for any table, rows remain on
   `example`, the moved count differs from the dry run, or `nathan`'s count is not
   the expected sum. On failure: do not reopen; re-run the dry run, find the
   writer, and re-run (it only moves rows still on `example`).
5. **Web env** (host dashboard, Production):
   - **First remove** every `TRACKER_USER_MAP` entry and every `TRACKER_API_KEYS` entry
     whose user is already `nathan` (leftovers from the test user would otherwise get
     full access to the migrated data).
   - Then map your email to `nathan`, and change each `"user":"example"` key entry to
     `"nathan"`. Redeploy.
   - Verify: every entry that resolves to `nathan` is yours; none still says `example`.
   - Preview: set the Preview `TRACKER_USER_MAP` to the same user. Preview backends
     never hold production data; `scripts/seed-preview.mjs` seeds synthetic rows
     for `PREVIEW_SEED_USER` (default `nathan`).
6. **Data repo** (one commit, from an up-to-date main):
   - `python scripts/rename_state_user.py --data-dir <data-repo> --from nathan --delete --write`
   - `python scripts/rename_state_user.py --data-dir <data-repo> --from example --to nathan --write`
     (each run prints a dry-run report first if `--write` is omitted; writes are
     atomic per file and leave `state/*.json.bak`; delete the `.bak` files before
     committing, or restore from them if a run was interrupted)
   - `git mv users/example.yaml users/nathan.yaml` and set `name: nathan`.
   - Close the old test dashboard issue (#34). Issue #15 is retitled automatically
     by the next watch run.
   - The `staging` branch keeps `users/example.yaml`; that is fine, since staging uses
     `STORE=github` and never writes to Convex.
7. **Repository rename**: rename `npothu/intern-watch` to `npothu/intern-baddie`, then
   immediately merge the prepared data-repo commit from step 4 of "Before the
   window". Update local remotes (`git remote set-url origin ...`).
8. Change `user` to `nathan` **in place** in each API key file. Keep
   `~/.config/intern-watch/script-key.json` where it is (the `job-agents` launcher and
   agent docs read that path) and add `ln -s ~/.config/intern-watch ~/.config/intern-baddie`
   for the renamed docs.
9. **Reopen**: `npx convex env remove --prod TRACKER_MAINTENANCE`, re-enable the
   workflows, then verify: `GET /api/v1/me` returns `nathan`, the web app shows the
   same counts as before, a manual `watch` dispatch succeeds and commits state, and
   the Vercel deployment still builds from the renamed repository.

## Expect afterwards

- Digest emails start a new Gmail thread (new subject prefix and thread anchor; the
  anchor also hashes the user). Filters matching "intern-watch:" need updating.

## Rollback

Before step 5 the rename is reversible with the same action in the other
direction (`from: nathan, to: example`). The deleted test user is not
recoverable except from a Convex backup (take one with `backup.yml` first).
Revert env and data-repo commits the same way.
