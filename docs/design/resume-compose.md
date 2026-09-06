# Resume Compose implementation

- [x] Ground the existing profile, autosave, export, generation, and browser paths.
- [x] Sketch two candidate data models and choose the simplest complete model.
- [x] Implement variant copying, project and bullet selection, locks, and base comparison.
- [x] Implement exact preview, overflow warnings, reviewed cut suggestions, and tailoring from a saved variant.
- [x] Verify data isolation, PDF/DOCX content, lock invariants, responsive UI, and deployed workflows.
- [x] Complete both reviews, open a ready PR, and verify the hosted preview before production release.

Scope: implement option 3 of the hosted mock, inside the production Resume area.
Library keeps all content; Compose manages saved variants.
Each variant can independently include/exclude and restore entries and bullets, preserve wording and order on duplication, lock entries/bullets against generation and trimming, compare with base, preview actual output, download exact selections, review optional one-page cut suggestions, and tailor for a selected job from the current variant.
Existing saved profiles and existing per-entry variant bullet strings must continue working.
Custom downloads never silently trim.

Current boundaries:
- convex/profile_schema.ts is pure v2 data types and helpers; web/lib/profile.ts mirrors them plus editor helpers.
- ProfileEditor holds whole-profile draft and serialized debounced autosave; current variant state is local and existing bullet editor replaces string arrays.
- hiddenIn is entry-level per variant; bullets maps variant to string array with base fallback.
- Resume export POST sends the live draft to Convex exportProfile, which builds PDF/DOCX with shared renderers.
- Generated resume requestBuild schedules runBuild from the saved profile; scoring limits to four projects; PDF fitter may condense or trim optional content.
- Prior hidden-project fix is on this branch, unmerged PR70. Auto follows base visibility, named builds variant visibility, auto avoids hidden variants.
- Vercel preview deploys a branch-specific Convex backend. No dev server may be started per user instructions.

## Design decision

Use additive saved resume snapshots, retaining the v2 Library and legacy variant arrays.
The two reviewed candidates were sparse selection metadata around existing arrays and independent saved snapshots.
Snapshots preserve a copied resume after Library wording, ordering, or content changes and avoid parallel text and identity arrays.
We accept repeated stored content in return for that independence.
New Library content is added explicitly and begins excluded.
The presence of `savedResumes`, including an empty array, marks migration and prevents deleted variants from returning.
Legacy named arrays continue to supply automatic Library-based generation, while explicit named builds resolve saved snapshots.

`shared/resume-compose.ts` owns copying, legacy conversion, resolution, comparison, and acceptance of cut proposals.
Its only Convex import is type-only and cannot enter the browser runtime graph.
The resolver emits a base-only profile containing selected content in its selected order.
PDF preview, exact PDF and Word downloads, cut measurement, and explicit-variant tailoring all consume that resolved profile.
The request mutation captures profile JSON before scheduling a build, so later saves cannot change its source.
Protected text never enters the rewrite payload, and a final merge retains locked original bullets.
Project IDs distinguish projects with identical headings during rewriting and section rendering.

Custom output and explicit-variant tailoring paginate without automatic cuts.
Cut suggestions are reversible bullet or optional-entry exclusions measured with the real PDF renderer.
The proposal records the full source revision, including locks and excluded content, and applies only accepted choices against that unchanged revision.
The preview rerenders after applying a subset.
When protected content prevents one page, the user can retain a multipage document.

## Verification

The branch passes 390 TypeScript tests and 993 Python tests, with one Python skip.
Web lint, web and Convex TypeScript checks, production Next build, Ruff, mypy, and configuration checks pass.
Both review axes completed, and their concrete findings were fixed and rechecked.
Signed-in browser verification on the separate Vercel preview database covered copying a saved variant, excluding a project and bullet, locking a remaining bullet, comparison, accepting one cut, actual two-page PDF preview, both download formats, a selected-job build, and reload persistence.
Downloaded custom and tailored PDF and Word files were parsed to verify the exact excluded project and bullet were absent and the protected bullet remained.
At a 390px viewport, both PDF pages render without horizontal overflow.
The preview deployment has no shared AI key, so its build exercised the explicit fallback; an automated action test exercises adversarial AI rewrites, captured-source rebuilds, and manual overrides of duplicate-named projects.

The editor retains pending drafts and a serialized save queue across client navigation.
A hosted regression check returned to Resume in 1.3 seconds while its save was delayed for 15 seconds and confirmed the exclusion remained visible.
The queue retries independently of the mounted editor and guards stale route responses and import writes.
Reviewed whole-entry cut suggestions were accepted in the hosted preview and the actual PDF recalculated from two pages to one.
