# Auto-goal: complete the eval e2e/script architecture, then debug+optimize with it

## Completion promise (must be quotably TRUE to exit)

> `pnpm eval` runs the full tutor evaluation stack — node unit + jsdom render +
> browser smoke — and exits 0. Tier-1 render coverage spans every StoryScreen
> phase (reading / paused / listening / thinking) plus finished / micDenied /
> QA-answer-bubble / scene dots, AND adds InputScreen + LoadingScreen render
> tests. Tier-2 browser smoke covers the reading / muted / listening / finished
> preview variants. Every issue the expanded eval surfaced has been fixed and
> the whole stack re-runs green, documented with final pass counts + the list
> of bugs found and fixed.

## Matrix (rebuild every iteration)

### Phase 1 — Architecture (完善)
- A1. Unified `pnpm eval` entry: node + jsdom + browser smoke; exits 0.
- A2. Tier-1 StoryScreen: phases reading/paused/listening/thinking + finished + micDenied + QA answer bubble + scene-dot count.
- A3. Tier-1 InputScreen render test (topic input, presets, begin, onBegin wiring).
- A4. Tier-1 LoadingScreen render test (its state variants).
- A5. Tier-2 preview parametrized (reading/muted/listening/finished) + smoke asserts each variant's layout.
- A6. scripts/e2e/README + a top-level eval doc updated to describe the unified stack.

### Phase 2 — Debug + optimize (基于它)
- B1. Run full expanded eval → enumerate EVERY failure (the debug surface).
- B2. Fix each surfaced bug → re-verify green.
- B3. Optimize concrete issues the eval surfaces (a11y: toggle buttons need aria-labels; any console error in a preview variant; etc.).
- B4. Whole stack green + documented.

## Confidence rule
Every reconciliation cell carries HIGH/MED/LOW. LOW+PASS is forbidden.

## Notes
- *.render.test.tsx → jsdom vitest project (vitest.setup.jsdom.ts stubs scrollTo + media.play()).
- Browser smokes need a dev server up; restart it after server-side edits.
- Standing rule: after every fix, restart server → self-e2e → only report when green.
