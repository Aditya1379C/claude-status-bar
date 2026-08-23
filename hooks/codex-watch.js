#!/usr/bin/env node
// launchd guardian. Codex here is the ChatGPT desktop app (bundle com.openai.codex), which does not
// run ~/.codex/hooks.json, so nothing launches the status bar when you open Codex without Claude.
// This runs on a short StartInterval and launches the app whenever Codex is open and the app is not
// already up. The app self-quits on its own once neither Codex nor Claude is around (checkLifecycle),
// so this never keeps it alive past its welcome. Idle cost is a couple of pgreps.

const cp = require("child_process");

const isUp = (name) => {
  try { cp.execSync(`pgrep -x ${name}`, { stdio: "ignore" }); return true; } catch { return false; }
};

if (isUp("ChatGPT") && !isUp("ClaudeStatusBar")) {
  cp.spawn("open", ["-g", "-b", "com.local.claudestatusbar"], { stdio: "ignore", detached: true }).unref();
}
