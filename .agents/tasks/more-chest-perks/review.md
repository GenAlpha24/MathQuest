# Seven new treasure chest perks in index.html

Adds 50/50, Free Skip, Double Points, Gem Magnet, Slow-Mo, Super Jump and Streak Saver to chests via a weighted table (classics 20 each, new 8 each), a HUD perk strip, a Free Skip button, and Help text. One commit, one file.

Watch for: 50/50 is spent even when it cannot help (2-option question, or typed mode) (confirmed, low); the Help text edit dropped emoji variation selectors on the original shield and timer lines (confirmed, cosmetic); the commit message states results without separating executed from traced checks (confirmed, low).

**Verdict**: APPROVED

## High-level view

Scope is clean: the diff touches only index.html, in the chest, battle, jump, update loop, HUD and Help areas. Nothing in the Firebase block, auth, roles, rules, rules-test or functions/ changed. Untracked .agents, .kiro and functions/ are not committed.

Original rewards keep their exact effects; only their odds drop from 25% each to about 14.7% each (59% combined), which matches the stated "classics still most common" intent. Counted perks are capped (4/2/10/2/8) and the topUp helper enforces them; the HUD signature encoding has no collisions at those caps.

Timed perks decrement inside update(), which only runs in the "playing" state under the fixed-step accumulator. They freeze on pause and during battles, and a hidden tab is capped at 250 ms of catch-up per frame. buildLevel clears magnet and slow-mo; gameOver and both start handlers call resetPerks. Counted perks deliberately survive levels and are documented in Help. Score, best and leaderboard code is unchanged except that the points computed in answerQuestion are doubled before being added, so persistence is unaffected.

Perf: the perk strip rebuilds its string only when the signature changes. The magnet loop does no allocation. One measureText per frame is only paid while a perk is active.

<details>
<summary>Issues (3)</summary>

1. **50/50 wasted** — fiftyLeft is decremented before checking that removal is possible (toRemove can be 0 for 2 options) and applies in typed mode, where removed options become untypeable. Decrement only when something is removed (likely, low).
2. **Help emoji regression** — the shield and timer emoji in the original Help sentence lost their variation selectors, so they may render as text glyphs. Restore them (confirmed, cosmetic).
3. **Verification reporting** — the commit message says "106 checks pass" and a soak run, but doesn't say which perks, battle modes or pause paths were exercised versus only traced. The harness lives outside the repo, so it can't be re-checked. State this in the PR (confirmed, low).

</details>

<details>
<summary>Details</summary>

## Where reading the code left gaps

Free Skip is guarded on state, questionAnswered and stock, stops the timer, and reuses the existing endBattle/loadQuestion timeouts, so it behaves like a correct answer minus points and life. It leaves the streak untouched. Streak Saver only triggers when correctStreak > 0, in both the wrong-answer and time-up paths. Slow-mo has a speed floor so slow Speed settings are not slowed further. Boulder drift uses the scaled speed; no other code reads scrollSpeed per step. Magnet only moves gems; collection and the life rules stay in the original overlap check.

Not exercised by me: the browser. I did not re-run the coder's suites, as instructed.

</details>

<details>
<summary>File map</summary>

index.html: Help text, Skip button, perk state and caps, 50/50, streak saver, free skip, double points, super jump, slow-mo, magnet, weighted chest table, perk strip. Full diff: `git diff origin/main...feature/more-chest-perks`.

</details>
