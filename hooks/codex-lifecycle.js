#!/usr/bin/env node
// Codex SessionStart launcher. Ensures ClaudeStatusBar is running so it can start polling
// ~/.codex/sessions rollout logs. Deliberately does nothing else: it runs under Codex's env
// (no CLAUDE_CODE_* vars, no session id we could trust), so writing a state.d file here would
// create a bogus/duplicate row. The app discovers Codex sessions itself by polling rollouts.

const cp = require("child_process");

const BUNDLE_ID = "com.local.claudestatusbar";
const EXEC = "ClaudeStatusBar";

const running = () => { try { cp.execSync(`pgrep -x ${EXEC}`, { stdio: "ignore" }); return true; } catch { return false; } };

if (!running()) {
  cp.spawn("open", ["-g", "-b", BUNDLE_ID], { stdio: "ignore", detached: true }).unref();
}
