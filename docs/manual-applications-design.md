# Manual applications and Inbox catalog search

## Problem

Inbox used classifier-ranked candidates as the complete set of selectable applications.
Tracker could only gain an application when a discovered match was marked applied.
Neither path supported a company-only application that the watcher never found.

## Usage

Tracker opens a shared `CreateApplicationDialog` and calls `createApplication` with a stable request ID and a draft.
Only the company is required.
The form reveals the role, location, job link, status, applied date, and note as optional details.

Inbox opens `ApplicationPicker` with the full ledger catalog and the classifier candidates as suggested item IDs.
The picker searches company, role, location, link, and status.
Creating from Inbox sends the same draft inside `mail.resolveAction`, so application creation and email resolution commit in one Convex mutation.

## Shape

`shared/applications.ts` owns application statuses, boundary validation, normalization, request ID validation, and retry fingerprints.
`convex/manual_applications.ts` owns synthetic identity allocation, collision handling, snapshot construction, retry behavior, and the initial status timeline.
`convex/ledger.ts` remains the only writer for application status and history.
`tracker.createManualApplication` exposes standalone creation for Tracker.
`mail.resolveAction` owns the atomic Inbox path and returns the full structured application catalog through `mail.getActions`.

Manual applications live only in the permanent `applications` ledger.
They do not create `matches` or `ticks` rows, so watcher snapshots cannot prune them.
The generated 12-character short key follows the existing SHA-1 convention.
URL-backed applications use the same identity as manual URL ingest and reuse a current match when both URLs identify the same posting.
A company-only key probes applications, matches, and ticks before it is accepted.
A retry with the same request ID and normalized draft returns the existing application.
A retry with changed details fails as a conflict.
Hash collisions probe deterministic salted identities instead of overwriting another row.

## Synthesis decision

The selected design keeps two narrow public capabilities instead of adding a generic command endpoint.
Tracker creation and Inbox resolution share one ledger helper, while `mail.ts` keeps ownership of Inbox state.
The competing design contributed changed-draft conflict detection, deterministic collision fallback, URL search, and explicit `createdAt` regression coverage.
The generic command union, backend-generated search text, and branch-specific result flags were rejected because they exposed presentation and transport decisions to unrelated callers.

## Tradeoffs accepted

- The Inbox loads the user's compact application catalog once so search has no request delay.
- A progressed manual application gets an `applied` history event on the supplied date and a current-status event at creation time.
- Request metadata lives in the manual snapshot so retry safety does not require a new table or index.

## Verification

Convex tests cover company-only creation, every optional field, historical dates, retries, conflicts, catalog ownership, existing targets, atomic Inbox creation, and unknown targets.
The picker has pure tests for complete-catalog search and suggestion ordering.
The production web build type-checks imports from the shared domain module.
