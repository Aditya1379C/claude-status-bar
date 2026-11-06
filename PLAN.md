# PLAN — Codex usage integration

## Goal
Surface OpenAI Codex CLI activity and quota in the same menu-bar app that already tracks Claude Code, by polling Codex's on-disk rollout logs (no Codex hooks, no network). The dropdown gains Codex session rows interleaved with Claude rows (each row labeled by source), plus an account-wide Codex plan-usage gauge; the top-level menu-bar icon animates when a Codex session is actively working, exactly as it does for Claude. Claude code paths stay behavior-identical.

## Data source (verified this session)
- Rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<startTs>-<uuid>.jsonl`, appended live during CLI/TUI use; file mtime tracks activity. The `<uuid>` in the filename is the session id.
- First line is `{"type":"session_meta","payload":{...}}` (may carry `cwd`); most lines are `event_msg` / `response_item`.
- Usage line (repeats): `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":N,...},"model_context_window":N|null},"rate_limits":{...}|null}}`.
- `rate_limits` when non-null: `{"primary":{"used_percent":Double,"window_minutes":Int,"resets_at":unixSeconds},"secondary":null|{same shape},"plan_type":String}`. `resets_at` is a real wall-clock unix timestamp (a live countdown against it is legitimate; the used_percent may be stale between sessions and that is inherent).
- Names: `~/.codex/session_index.jsonl`, one JSON object per line `{"id":..,"thread_name":..,"updated_at":..}` (not every session is listed; treat as best-effort name lookup).

## Files
- `Sources/CodexSource.swift` — NEW. All Codex disk reading + the gauge row view. Keeps main.swift focused; `build.sh` globs `Sources/*.swift`, so no build wiring needed.
- `hooks/codex-lifecycle.js` — NEW. Standalone launcher: if `ClaudeStatusBar` is not running, `open -g -b com.local.claudestatusbar`. Nothing else (must NOT write state.d — it runs under Codex's env, not Claude's).
- `hooks/install.js` — EDIT. Also install the Codex launch hook (see Auto-launch below). Read this file first to match its copy-into-install-dir + backup idioms.
- `hooks/uninstall.js` — EDIT. Remove the Codex launch hook entry the installer added.
- `Sources/main.swift` — EDIT, at these anchors only:
  - `struct Session` (~267): add a `source` field and Codex-only carry fields (below).
  - Controller stored properties (~296-307): add Codex state dicts/props.
  - `tick()` (~1052): call `reloadCodexSessions()` after `reloadSessions()`.
  - `evaluate()` (~1143): after the Claude reap loop, compute the icon `lead` over Claude + Codex sessions combined (do NOT run Codex through the pid reap).
  - `checkLifecycle()` (~1242): also stay alive while a recent Codex session exists.
  - `menuNeedsUpdate(_:)` (~533): render Codex rows in the same "Sessions" list, and the gauge row.
  - `configureSessionRow` (~797), `sessionName` (~836), `surfaceTag`/pill usage (~876/806), `sessionSymbol` (~910): make source-aware.
  - `sessionMenuLine` (~775): source-aware tooltip prefix.

## Design

### Session struct (main.swift)
Add:
```swift
enum Source { case claude, codex }
var source: Source = .claude
// Codex-only (unused for Claude):
var codexTokens: Int? = nil        // total_token_usage.total_tokens
var codexCtxWindow: Int? = nil     // model_context_window (nil = unknown -> show tokens without %)
```
Everything else (`id`, `project`, `displayName`, `cwd`, `branch`, `ts`, `transcript`, `eff`) is reused. For Codex: `transcript` = rollout path, `ts` = rollout mtime (unix), `pid` = 0, `entrypoint` = "", `startedAt` = 0 (Codex rows show no elapsed timer — we cannot derive a reliable turn start), `state`/`eff` = `"thinking"` when active else `"idle"`.

### Controller state (main.swift)
```swift
var codexSessions: [String: Session] = [:]      // id -> most recent parsed Codex session (recent files only)
var codexFileMTimes: [String: Date] = [:]       // rollout path -> last-parsed mtime (re-tail only on change)
var codexNames: [String: String] = [:]          // id -> thread_name (from session_index.jsonl)
var codexNamesMTime: Date? = nil                 // session_index.jsonl mtime when codexNames was built
var codexUsage: CodexUsage? = nil               // account-wide rate-limit snapshot (freshest seen)
let codexDir = (NSHomeDirectory() as NSString).appendingPathComponent(".codex")
let codexActiveWindow: TimeInterval = 20         // mtime within this => "working"; heuristic, tune later
```
`CodexUsage` (in CodexSource.swift):
```swift
struct CodexWindow { let usedPercent: Double; let windowMinutes: Int; let resetsAt: Double }
struct CodexUsage { let primary: CodexWindow; let secondary: CodexWindow?; let plan: String; let sampledAt: Date }
```

### CodexSource.swift
`reloadCodexSessions()` (extension method on StatusController):
1. If `~/.codex/session_index.jsonl` mtime changed since `codexNamesMTime`, rebuild `codexNames` by parsing each line for `id`/`thread_name`. Tolerate malformed lines.
2. Candidate rollout files: only today's and yesterday's date dirs, derived from the calendar (`sessions/<Y>/<M>/<D>`, zero-padded), so enumeration is bounded and midnight-safe (a session started yesterday still lives in yesterday's dir). Missing dirs are fine. List `rollout-*.jsonl` in each.
3. Drop the whole `codexSessions` set that no longer qualifies: rebuild it fresh each call from the candidates whose `now - mtime <= codexRetain` where `codexRetain = max(stalePruneAge, codexActiveWindow)` (idle Codex rows honor the same "Hide Idle" threshold as Claude; when Hide Idle = Never, keep any from the two scanned dirs).
4. For each qualifying file: mtime-gated — if `codexFileMTimes[path] == mtime`, reuse the existing parsed `Session` (just recompute `eff` from the current mtime); else tail the last ~64KB, split into lines, scan from the end for the FIRST line whose `payload.type == "token_count"`, and read `total_token_usage.total_tokens`, `model_context_window`, and `rate_limits`. Also read line 0 once for `session_meta.payload.cwd` (best-effort; drives branch). Build the `Session`.
5. id = uuid parsed from the filename (`rollout-<ts>-<uuid>.jsonl`, uuid is everything after the timestamp prefix, before `.jsonl`). name via `codexNames[id]` -> else cwd basename -> "codex". `branch = branchForCwd(cwd)` (reuse existing; "" when unknown).
6. `eff = (now - mtime <= codexActiveWindow) ? "thinking" : "idle"`; also set `state` to the same so existing helpers behave.
7. Account usage: among files parsed this call that carried a non-null `rate_limits`, keep the one from the most-recently-modified file into `codexUsage` (only overwrite if that file's mtime >= current snapshot's; a session with null rate_limits does not clear it).

`GaugeRowView: NSView` — a disabled menu-row custom view: left label (window name), a rounded track with a filled portion (fill fraction = usedPercent/100, brand `#d97757` fill, tertiary track), and a right caption "P% · resets in Xh". Width from `uiConfig()["boxWidth"] ?? 300`, height ~26, left inset aligned with `infoRow` (label x=38). Reset caption: format `resetsAt - now` as "resets in Xh"/"Xm" (live and correct; never displayed as absolute stale data). Window name from `windowMinutes`: 300->"5h", 1440->"daily", 10080->"weekly", 43200->"monthly", else "\(minutes/60)h".

### main.swift wiring
- `tick()`: `reloadSessions(); reloadCodexSessions(); evaluate()`.
- `evaluate()`: leave the Claude loop and reap UNCHANGED. Replace only the `lead` computation to range over `Array(sessions.values) + Array(codexSessions.values)` (Codex `eff` already set by the reader). Codex `eff == "thinking"` drives the same animate branch, so the icon animates for active Codex work. `renderResting()` when the combined lead is resting. Codex is never pid-reaped (it lives only in `codexSessions`, which the reap loop never touches).
- `checkLifecycle()`: change the stay-alive test to `if claudeDesktopRunning() || sessionCount() > 0 || !codexSessions.isEmpty`. (Only recent Codex sessions are ever in the dict, so this cannot pin the app forever.)
- `menuNeedsUpdate`: after Claude `visible` is computed, build `codexVisible` = `codexSessions.values` filtered by the same idle-hide rule (no forced floor). Merge Claude `visible` + `codexVisible` into one array sorted by `ts` desc and render each via the existing row loop (SessionRowView + `configureSessionRow`). The `activeLead` for context rows is computed over the combined set. If the lead is a Codex session, its context rows come from a new `codexContextRows(for:)` (tokens, and `/window · P%` only when window known). After the session rows, if `codexUsage != nil` AND at least one Codex row is visible, append the gauge row(s): primary always, secondary when present. Keep the existing "Sessions" header; do not add a separate Codex section (unified list, per the chosen layout).
- `sessionName(_:)`: if `source == .codex`, skip `chatTitleIndex`; return `displayName`/`project` fallback chain.
- Pill: in `configureSessionRow`, if `source == .codex` use `pillImage("CODEX")` (normal + selected) instead of `surfaceTag(entrypoint)`. Claude rows keep CLI/APP unchanged.
- `sessionSymbol`: unchanged mapping works (thinking->spinner, idle->caret); no permission state for Codex.
- `sessionMenuLine`: prefix "Codex: " when `source == .codex` so the menu-bar tooltip is unambiguous.

### Auto-launch from Codex (hooks/)
Context: the app installs its hook scripts into `~/.claude/statusbar/` and wires Claude's `settings.json`. Codex uses a Claude-compatible `~/.codex/hooks.json` (already present on this machine, hand-pointed at the statusbar scripts). Make this official and reinstall-durable, owned by `install.js`:
1. `codex-lifecycle.js` is copied into the same install dir as the other hook scripts (alongside `lifecycle.js`). It ONLY launches the app; it never writes session state (Codex env lacks the Claude vars, so writing state.d would create bogus/duplicate rows — the app already discovers Codex sessions by polling rollouts).
2. In `install.js`, after the existing Claude wiring: if `~/.codex/` exists, read `~/.codex/hooks.json` (treat missing/invalid as `{}`), back it up ONCE to `hooks.json.bak-statusbar`, and merge a guarded `SessionStart` entry whose command runs the installed `codex-lifecycle.js` via the same node path the installer already resolves. Idempotent: match/replace only our own entry (identify it by the `codex-lifecycle.js` basename in the command), never touch other hooks. If `~/.codex/` is absent, skip silently. Do not remove or rewrite any pre-existing entries (including the hand-added ones pointing at `update.js`/`lifecycle.js`).
3. In `uninstall.js`, remove only the entry whose command contains `codex-lifecycle.js`, mirroring how it already removes the launchd agent.
Uncertainty to note in the handoff: whether Codex actually executes `hooks.json` depends on this Codex build; if it does not, auto-launch silently no-ops and the fallback (a launchd `WatchPaths` agent) is a separate follow-up, out of scope here.

## Behavior & edge cases
1. A Codex session actively producing tokens (rollout mtime within 20s) shows a spinner row and animates the menu-bar icon; between turns it falls back to an idle caret row within ~20s.
2. Codex rows are labeled with a "CODEX" pill; Claude rows keep their existing CLI/APP pill. Rows from both sources interleave by recency in one "Sessions" list.
3. The gauge shows the primary rate-limit window filled to `used_percent`, with a live "resets in Xh" from the real `resets_at`. A secondary window, when present, gets a second gauge line. The gauge appears only when a Codex session is currently visible (ties freshness to activity; no stale-forever gauge).
4. `model_context_window == null` -> Codex context row shows compact tokens only (e.g. "162k"), no percent, no fabricated denominator.
5. Idle Codex rows obey the existing "Hide Idle Sessions" setting; "Never" keeps any from the scanned day dirs. Claude's floor-of-one is unaffected and Codex never forces a floor.
6. No `~/.codex` dir, no rollouts, or all-stale -> zero Codex rows, no gauge, Claude behavior identical to today.
7. Torn/truncated tail lines fail their JSON parse and are skipped (mirror `contextTokens`); a lossy UTF-8 decode is used so a split leading multibyte char never drops the read.
8. Starting a Codex session (SessionStart hook) launches the app if it is not already running, via `codex-lifecycle.js`; it then stays alive while Codex is active. Re-running `install.js` re-establishes the Codex hook without duplicating it or disturbing other hooks.

## Out of scope
- The launchd `WatchPaths` fallback for the case where this Codex build ignores `hooks.json` (a separate follow-up; note it in the handoff).
- Codex "awaiting permission" / fine-grained turn states (rollouts do not expose a clean per-turn signal; we use active/idle from mtime only).
- Per-session elapsed timer for Codex (no reliable turn-start; Codex rows show no clock).
- Any change to Claude parsing, reaping, sound, or icon behavior.
- Reading Codex `auth.json`, sqlite state, or any network/API call.

## Verification
- Build (clean): `cd ~/Developer/claude-status-bar && ./build.sh 2>&1 | grep -E "(error|warning):" | head -50`
- Deploy: `osascript -e 'quit app "ClaudeStatusBar"'; rm -rf /Applications/ClaudeStatusBar.app && cp -R build/ClaudeStatusBar.app /Applications/ && open -b com.local.claudestatusbar`
- User checks manually (I will not drive the screen):
  1. With a Claude session running, the dropdown looks and behaves exactly as before (rows, pills, context row, settings).
  2. Start a Codex CLI session and give it a task: a row tagged "CODEX" appears, spinner animates while it works, and the menu-bar icon animates too.
  3. The Codex row shows the thread name (or cwd basename), and interleaves by recency with any Claude rows.
  4. A "Codex ... monthly" gauge appears filled roughly to the account's used percent, with a "resets in Xh" caption; a second window line shows if the account has one.
  5. Let the Codex session go quiet: within ~20s the row drops to an idle caret; it hides per the current "Hide Idle" setting.
  6. Quit Codex and Claude both: the app self-quits as before (no lingering).
  7. Auto-launch: fully quit the app, then start a Codex session — the menu-bar icon reappears on its own. Re-run the installer (`node hooks/install.js` or the plugin's reinstall path) and confirm `~/.codex/hooks.json` still has exactly one `codex-lifecycle.js` entry and no other hook was altered.
