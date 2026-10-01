# Agent notes for this repo

Chrome MV3 extension; plain JS, no build step for the source. Read README.md first; status lives in REVIEW_READY.md and docs/.

- Load path for review is `build/review-unpacked` (made by `node tools/build.mjs build/review-unpacked`). Only rebuild it when promoting a verified build; tell the user to click Reload.
- Verify with `cd tests && npm test` and `node browser/run.mjs <builtDir> --label <name>`. The harness must stay isolated: temp profile, all non-local hosts blocked, `--mute-audio`, synthetic fixtures only.
- Chrome caps a toolbar popup at 600 px tall and 800 px wide; the screen is 440 px wide and must stay under 600 px (W-NO-DEAD-SPACE enforces it). No emoji in the UI (unit test); icons are inline SVG symbols in popup.html.
- Shell hygiene: never put backticks in a double-quoted `git commit -m`; write messages to a file and use `-F`.
- Never: edit the old copy under `…/T3 Code/t3-nightly-toy/`, touch the user's Chrome profile or live install, contact Tidal with the user's session, capture real tabs or microphone, broaden permissions or CSP (the one addition so far, `sidePanel`, is decision R-20), add a manifest `key`, publish to the Web Store, make the repo public, or force-push.
- Don't fake success or invent data in the UI. Label demo data.
- Presets are the user's. Never add, rename, re-tune, reorder or remove a factory preset, and never migrate stored presets, without the user's explicit OK in that conversation (rule R-07, 2026-10-01). Propose first, with the exact before/after list.
- Record design answers in docs/DESIGN_DECISIONS.md and coverage in docs/DESIGN_REVIEW_MAP.md. FINAL_HANDOFF.md, SESSION_HANDOFF.md and dated assessments are historical: don't rewrite them.
