# Mail sync: statuses from recruiter email (optional, Convex-only)

Recruiter emails (rejections, OA invites, interview requests, offers) update
your application tracker automatically.
Unambiguous emails apply the status on their own; anything uncertain lands in
the webui's **Inbox** tab, where one click resolves it - with a deep link to
the exact Gmail message.

Requires the Convex tracker driver (`STORE=convex`).
Under the default GitHub-issue driver the feature is inert and the tab never
renders.

## How it decides

```
Gmail (your applying account)
  -> users.watch push -> Cloud Pub/Sub -> POST /gmail/push (Convex, doorbell)
  -> internal sync: history.list since the stored cursor -> messages.get
  -> classify (regex port of src/apply/inbox.py; Gemini fallback, queue-only)
  -> score tracked applications (sender domain / company phrase / title)
  -> auto-apply | queue an Inbox action | ignore
```

Auto-apply happens only when ALL of these hold; everything else queues:

- the signal came from the regex rules (an LLM verdict always queues);
- exactly one application matches decisively (score >= 3 and any runner-up at
  most half of it);
- the transition is forward-only (`applied < oa < phone_screen < interview <
  offer`; `rejected` allowed from any non-terminal; a repeat of the current
  status is skipped; backward or from-terminal changes queue).

Auto-applied changes are ordinary history entries - the note carries the
evidence quote plus a Gmail deep link, and you can override the status in the
Tracker tab at any time.
Processed messages are recorded per Gmail message id, so redelivered pushes
and overlapping syncs never double-process.

## One-time setup

GCP (console.cloud.google.com, any project you own):

1. Enable the **Gmail API** and **Cloud Pub/Sub API**.
2. OAuth consent screen: External; scope `gmail.readonly`; then **Publish app**
   (leave it unverified - publishing is what stops refresh tokens from
   expiring every 7 days in testing mode).
3. Credentials -> Create OAuth client ID -> **Desktop app**. Note the client
   id + secret.
4. Pub/Sub: create a topic; grant **Pub/Sub Publisher** on it to
   `gmail-api-push@system.gserviceaccount.com`.
5. Create a push subscription on the topic with endpoint
   `https://<your-deployment>.convex.site/gmail/push?token=<MAIL_PUSH_TOKEN>`
   where `MAIL_PUSH_TOKEN` is a random 32+ char string you generate.

Convex deployment env vars (Dashboard -> Settings -> Environment variables):
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `MAIL_PUSH_TOKEN`,
`MAIL_PUBSUB_TOPIC` (`projects/<project-id>/topics/<topic>`), and
`GEMINI_API_KEY` (optional - enables the queue-only LLM fallback, capped at
20 calls/account/day).

Deploy the backend (`npm run deploy`), then authorize locally:

```
python -m src.mail_auth            # add --user <name> if you run several users
```

Add `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` to your local `.env` first; the
CLI runs the browser consent flow with your **applying** Gmail account (which
need not be the digest-sender account) and stores the refresh token in Convex.
It arms the Gmail watch immediately; a daily cron renews it (watches lapse
after ~7 days) and a reconcile sweep re-syncs accounts that missed a push.

## Verify

Send yourself a test email containing a phrase like "we have decided not to
move forward with your application" from another account.
Within seconds the push should land (Convex logs), and the message should
appear either as an auto-applied status in the Tracker tab or as an Inbox
action.
A job-alert or "thanks for applying" confirmation email must be ignored.

## Troubleshooting

The webui banner surfaces mail-sync health: `mail sync error: ...` (the last
failure, e.g. `invalid_grant` after revoking consent - rerun
`python -m src.mail_auth`), `mail sync stalled (>48h)`, and
`gmail watch expired - rerun setup`.
Gmail only pushes for INBOX mail: if recruiter mail lands in spam or is
auto-archived by a filter, it is never seen - keep ATS domains out of spam.
