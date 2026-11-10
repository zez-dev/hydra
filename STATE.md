# Hydra — state

<!-- Written by /wrap at session close. Newest log entry on top; keep about five. -->

## Now

- **Shipped:** v0.3.1, published 2026-11-10 as Latest (tag `v0.3.1` at `0441026544`), with the Mac DMG, the Linux AppImage, and the `.deb`. It holds the local-server fixes of `0ebd3794f1`, the `lean` Web agent preset, and the learning review off by default.
- **In flight:** four small upstream DeepSeek Harness fixes (upstream pull requests 7527, 7570, 7768, and 7792) are being picked onto a local branch and tested; nothing is pushed.
- **Next:** Decide how tool results are shortened when the context window fills: `dsh-compaction-tool-result-pruner` cuts earlier results in place, so a local server reads the conversation again from the first cut. Decide what follows an oMLX memory refusal (HTTP 400 `prefill_memory_exceeded`), which fails the turn today: wait and retry, or compact. Decide how a finished background job reaches a session on a local route: today it adds a user-role notice and wakes an idle session. Bring the Web e2e expectations up to date with Hydra: `openSettings()` in `apps/web/tests/support.ts` still clicks the removed DeepSeek "Account menu", the `standard` catalog case in `apps/cli/tests/web-agent-presets.e2e.ts` lacks Hydra's own tools, and the `skill-tool-row` UI golden predates "Rewind to here". Open the 0.3.1 packages on a Mac and on an Ubuntu desktop; they were built and checksummed, not opened.

## Log

### 2026-11-10
- Checked the 0.3.1 provider code against a running oMLX 0.7.4.dev1 server with one Gemma model, through a recording proxy: an `incomplete_tool_call` error frame is retried and the session finishes, the custom-route `chat_template_kwargs` are accepted, and no learning-review request follows a turn.
- In every recorded session, headless and the Standard preset, the system message and the tool list stayed identical and requests were append-only, through a failed read, a failed fetch, a bash exit code 2, a call moved to the background, and the turn a finished background job starts.
- On a scripted server with `contextWindow: 32768` the tool-result pruner rewrote earlier tool results on every second or third tool call once the estimate passed 80% of the window; the first cut changed 94% of the text the server had cached.
- Landed the learning review off by default (`reviewTurns: false` in the base bundle, with its upgrade guide) and version 0.3.1, then published v0.3.1: GitHub Actions built the three packages from `0441026544`, and the published checksums equal the local ones.

### 2026-11-09
- Added the `lean` preset: the `standard` rows with the workflow, plugin-management, usage, doctor, and off-peak tool rows disabled; listed after Standard and visible with Coding Tools off; copy in all eight UI locales.
- Measured on the fake oMLX rails, first request: 45,303 → 36,905 characters of system prompt plus tool schemas (−18.5%), 37 → 33 tools; the remaining schemas are byte-identical to Standard's.
- Lean reads the clock at most hourly (`refreshIntervalMs: 3600000`), so fewer mid-turn user-role messages force a re-prefill on chat templates that drop earlier reasoning.
- Added the authored `snapshots/web/lean-preset` scenario (header class `web-lean`), the exact-catalog e2e case for `lean`, and e2e cases showing that a saved default, a stale-order preset override, and a profile's own `lean` declaration all survive the change.
