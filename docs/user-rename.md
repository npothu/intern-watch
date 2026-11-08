# Renaming a tracker user key (runbook)

Used for the 2026-11 rename of `example` to `nathan`. The user key is stored in
three places that must change together:

| Where | What holds the key |
|---|---|
| Convex (19 tables) | the `user` field on every per-user row |
| Web host env | `TRACKER_USER_MAP` (email -> key) and each `TRACKER_API_KEYS` entry's `user` |
| Data repo | `users/<key>.yaml` (`name:`), `state/applications.json`, `state/seen.json` |

SHORTs, credentials, resume files and document ids do not change.

## Before the window

1. Merge the PR that adds `convex/migrations.ts` and `convex/maintenance.ts`, and let
   `deploy-convex.yml` deploy it. Nothing changes behaviour until step 3.
2. Merge the data repo change that makes `resume-batch.yml` / `resume-ondemand.yml`
   accept both dashboard titles.
3. Pick a window that avoids the daily mail crons (06:00 and 06:30 UTC) and the
   watch schedule. Pause every jobin / API-key agent.

## Window

1. **Stop writers**
   - `gh workflow disable watch.yml -R <owner>/<data-repo>` (and dashboard-write / resume*)
     and wait for any in-progress run to finish (`gh run list`).
   - `npx convex env set --prod TRACKER_MAINTENANCE 1`. Public queries, mutations
     and actions now fail with a maintenance message; Gmail pushes get a 503 and
     Pub/Sub redelivers them later; the daily mail crons skip.
   - Any Gmail-connect (OAuth) flow in progress must be restarted afterwards.
2. **Move any old target aside** (only if the dry run shows the new key already owns rows):
   `npx convex run --prod migrations:renameUser '{"from":"nathan","to":"nathan_legacy","dryRun":false}'`
3. **Dry run**:
   `npx convex run --prod migrations:renameUser '{"from":"example","to":"nathan","dryRun":true}'`
   `blockers` must be empty: maintenance on, no pending/running scheduled
   functions, no collisions. If scheduled functions are pending, wait for them or
   cancel them in the Convex dashboard.
4. **Migrate**:
   `npx convex run --prod migrations:renameUser '{"from":"example","to":"nathan","dryRun":false}'`
   Check `remainingOnFrom` is 0 and `after.nathan` equals `before.example` per table.
5. **Web env** (host dashboard): in `TRACKER_USER_MAP` map the email to `nathan`; in
   `TRACKER_API_KEYS` change each `"user":"example"` to `"nathan"`. Redeploy.
6. **Data repo** (one commit, from an up-to-date main):
   - `python scripts/rename_state_user.py --data-dir <data-repo> --from nathan --to nathan_legacy --write` (only if `nathan` exists there)
   - `python scripts/rename_state_user.py --data-dir <data-repo> --from example --to nathan --write`
   - `git mv users/example.yaml users/nathan.yaml` and set `name: nathan`.
   - Rename the surviving dashboard issue title to `📋 intern-baddie matches — nathan`
     (its number is now under `_meta.dashboard_issue.nathan`); close the old test issue.
7. Update `user` in each local API key file (`~/.config/intern-baddie/script-key.json`).
8. **Reopen**: `npx convex env remove --prod TRACKER_MAINTENANCE`, re-enable the
   workflows, then verify: `GET /api/v1/me` returns `nathan`, the web app shows the
   same counts as before, and the next watch run commits state without errors.

## Rollback

Before step 5 the rename is reversible with the same action in the other
direction (`from: nathan, to: example`). Revert env and data-repo commits the same way.
