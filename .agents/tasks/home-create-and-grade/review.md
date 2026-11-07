# Review: feature/home-create-and-grade (final gate)

Verdict: APPROVED. No HIGH or MEDIUM blockers. Based on the diff and the recorded results (unit 282, handler 29, e2e+client 26, rules 69, all pass); I did not re-run suites.

## Checklist
- Eligibility: `setCreateMenu` now toggles `#homeCreate` alongside the old menu items, so it uses the same condition (teacher, parent, active student; role-less only after backfill; hidden when offline, on logout and while pending). Client test covers student, pending to active, teacher, parent via Open game, legacy, offline and logout.
- My games reachable from the home buttons, which reuse the existing menu handlers (pause/freeze pattern kept).
- Grade selector: the existing `#gradeSelect` is now visible (the start screen was top-clipped; the CSS fix is limited to `#start`). `setGrade()` is the single path, uses `persistProgress` and adds no fields (test asserts the exact saved key set). `cgGrade` and `gradeSelect` stay in sync, and the build request uses the synced grade. Question generation is untouched.
- Custom runs: `persistProgress` still writes the pre-run snapshot, and a test changes the grade mid custom-run and asserts best/level are unchanged.
- Reading level: it counts alphabetic words only, so numbers and units are ignored. It also checks the longest sentence and the total, with a STEAM allowlist, and needs 3+ non-allowed words plus an average or long-word-share test. A single hard word never fails. Grade bands loosen with grade. Hard-text fixtures at grade 3 and 5 are still rejected. The URL and duplicate validators are unchanged. The G3 bar-graph fixture (about 31 tokens in Q5) fails the old check, so the new tests are real.
- Prompts: reading-level steering added. The retry passes only fixed check names, and a test asserts the earlier text is not echoed. Single retry and time budget unchanged.
- Handler: `gen_failed` is returned only when at least one output was invalid. No-usable-answer outages keep `model`. Auth, quota, refund and role logic are unchanged. The log fields contain only check names. Rules untouched.
- Client copy: one COPY table. `gen_failed` maps to its own message, and outage, quota, refusal (server message) and too-vague (refusal) are distinct. An end-to-end test asserts gen_failed differs from the outage copy.
- Scope: index.html changes are limited to the home screen, grade sync, COPY/CG_ERRORS and the CSS. Functions changes are limited to validate, prompts, handler and tests. The only doc change is the design doc. No new overlays, so the el map and hideAllOverlays need no changes.

## Non-blocking note (LOW)
Grade 1 and 2 total-word caps went from 18 to 22 and 28, while the sentence caps (15/18) are stricter. This loosens the early grades a little against "early grades stay strict". Pre-K to K stays at 12. The tradeoff is documented in the design doc, so it is not a blocker.
