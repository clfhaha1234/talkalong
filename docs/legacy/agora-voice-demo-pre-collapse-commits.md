a9bc8a7 fix(orchestrator): revert Q&A LLM to gpt-4o-mini (gpt-5-mini stalls barge-in)
a541dec fix(tutor): loading feedback, video fallback, mic-denied state, honest input copy
1b75b9d feat(tutor): hold on the last spread at story end instead of a terminal card
1106f4c chore(orchestrator): upgrade Q&A answer LLM gpt-4o-mini -> gpt-5-mini
41ce674 chore(orchestrator): switch narration voice to Japanese_DecisivePrincess
3b30b65 feat(lesson): animate scene illustrations via Remotion + remove dead pause button
9141d6f test(phase34): multi-interrupt support in resume harness + self-improve verdict
3283810 feat(orchestrator): real interrupt-timing signal + audio-paced word reveal
fb64574 feat(orchestrator): smart resume — lazy mic, real audio sync, llm-driven planner
44456ba fix(lesson): empty greeting, storybook persona, llm script generation with cache
8f8d07a feat(tutor): push-to-talk — mic defaults muted, central button toggles with clear hint
841f0da feat(tutor): port storybook UI — input, loading, story spread, mic-driven qa interrupt
3c7861a feat(api): /api/lesson/start route that composes scenes, generates images, and narrates
10f97dc feat(orchestrator): add startTutorSessionFromScenes entry point for lesson flow
8b8cebb feat(lesson): phase A scene composer stub (no LLM)
c68e557 chore: gitignore public/lesson-cache image cache dir
9c324e8 feat(lesson): style prompt constant + cache-keyed image-gen library
3cbe9cd feat(scripts): probe gemini-3.1-flash-image with storybook style prompt
9b33657 fix(tutor): surface audioTrack.play() rejection in diag panel
b784586 fix(registry): stash session map on globalThis to survive next dev HMR
0f7eade fix(orchestrator): handleQaEnded auto-enters BRANCH on first ping
e8cbe39 fix(tutor): manual user-published subscribe + play for reliable audio
ac3564c fix(orchestrator): hold session open until APPEND queue drains
9a24a8a feat(tutor): ui for branch state, qa transcript, and comprehension dial
ba52b0b feat(tutor): end-of-qa detector with silence timer and POST /qa-ended
08e5bee feat(tutor): subscribe to AgoraVoiceAI for agent state and transcripts
e0dddc3 feat(tutor): use react hooks for join and publish local mic
1408ee1 feat(orchestrator): wire phase 3 agora config via typed builder methods
7839c98 feat(api): /api/tutor/stop route
cbb5292 feat(api): /api/tutor/qa-ended route plus in-memory session registry
d0c1268 feat(orchestrator): wire handleQaEnded to bridge + rescript + segment swap
075b1d2 feat(orchestrator): gemini OpenAI-compat client with reasoning_effort baked in
feabd80 feat(orchestrator): narrator pushes all segments via APPEND, no sleep
2855fa2 feat(orchestrator): comprehension tracker with single-flip depth dial
88e944d feat(orchestrator): rescript LLM with watchdog and original-segments fallback
11fd556 feat(orchestrator): bridge LLM with watchdog and library fallback
0195608 feat(orchestrator): bridge fallback library
94e3064 feat(orchestrator): barge-in scheduler stub (answer_now only)
b904b6e feat(orchestrator): extend ProgressState with branch_line and comprehension signal
a125cd5 feat(orchestrator): outer state machine with transition table
7f2d6c4 feat(tutor): phase 1 narrator orchestrator with sse api and listener ui
f8eacd8 feat(scripts): add e1 narration control and e1.5 gemini bench experiments
d58c7fd chore: gitignore .agora project binding metadata
f430833 chore(test): add vitest for unit tests
c490d8c feat(scripts): probe agora phase 3 config plumbing via typed builders
5acdc02 Merge pull request #17 from AgoraIO-Conversational-AI/agents
