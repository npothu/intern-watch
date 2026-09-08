# Referrals

The hosted app's `/referrals` page keeps referral contacts and job-specific requests together.
The view switch, command palette, and `t` shortcut all include Referrals.
The people icon on a Matches or Tracker row opens a referral form with that job selected.

## Using the page

- Add a contact with a name and company before choosing a role.
  Email, profile link, relationship, availability, notes, and follow-up details are optional.
- Log a job referral against a contact and select a job from Matches or Tracker, or enter its details manually.
  A contact can have several referrals, and a company can have several contacts.
- Use Planned, Requested, Submitted, Declined, or Canceled to describe the referral.
  The application's Tracker status is displayed separately and never changes when a referral is saved.
- Keep a next step and optional calendar date on a contact or an individual referral.
  Follow-ups due includes today and earlier dates in the browser's local calendar.
  Mark done clears that record's follow-up; In 3 days reschedules it from today.
- Edit records or archive them for later reference.
  Archived records can be restored, and archiving a contact preserves their job referrals and notes.

## Storage and authorization

`referralContacts`, `referrals`, and `referralNotes` are separate Convex tables indexed by user.
The web server resolves the signed-in Clerk account on every read and save.
Convex checks the tracker secret and verifies ownership of every referenced record.
No new environment variables are required.

Linked jobs keep a snapshot of their company, title, URL, and term.
The snapshot survives when the watcher removes an old posting from Matches.
The application link is the existing 12-character short key; it never points at another user's records.
An active duplicate for the same contact and job key, job URL, or company/requisition pair is rejected.
Notes and status changes append dated activity records instead of replacing earlier notes.

## Deployment and verification

Deploy the Convex schema and functions with the web app through the repository's existing preview or production workflow.
The new tables start empty; existing records need no migration.
Use the development setup in [local web development](local-web-development.md) to test with Clerk and Convex.

The root Vitest suite covers persistence, job snapshots, account isolation, duplicate requests, archiving, follow-ups, safe links, and server-action authentication.
The web production build and lint checks cover the page and navigation integrations.
