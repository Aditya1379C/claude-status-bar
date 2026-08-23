#!/usr/bin/env node
// Installs the status-bar hooks into ~/.claude/settings.json (merging, never
// clobbering existing hooks) and copies update.js to ~/.claude/statusbar/.
// Re-runnable: existing status-bar hooks are stripped before re-adding.

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const home = os.homedir();
const sbDir = path.join(home, ".claude", "statusbar");
const MARKER = sbDir; // every hook command we add points inside this dir
const updateDest = path.join(sbDir, "update.js");
const lifecycleDest = path.join(sbDir, "lifecycle.js");
const settingsPath = path.join(home, ".claude", "settings.json");
const node = process.execPath;

// Retire the old 0.0.2 background watcher LaunchAgent on upgrade (0.0.3+ self-quits).
const OLD_AGENT_LABEL = "com.local.claudestatusbar.watcher";
const oldAgentPlist = path.join(home, "Library", "LaunchAgents", OLD_AGENT_LABEL + ".plist");
try { cp.execSync(`launchctl bootout gui/${process.getuid()}/${OLD_AGENT_LABEL}`, { stdio: "ignore" }); } catch {}
if (fs.existsSync(oldAgentPlist)) { fs.rmSync(oldAgentPlist); console.log("Removed old desktop watcher LaunchAgent."); }

fs.mkdirSync(sbDir, { recursive: true });
fs.rmSync(path.join(sbDir, "watcher.sh"), { force: true });
// Retire pre-multi-session artifacts (single global state + empty liveness markers).
fs.rmSync(path.join(sbDir, "state.json"), { force: true });
fs.rmSync(path.join(sbDir, "sessions.d"), { recursive: true, force: true });
fs.copyFileSync(path.join(__dirname, "update.js"), updateDest);
fs.copyFileSync(path.join(__dirname, "lifecycle.js"), lifecycleDest);

const cmd = (evt) => `${node} ${updateDest} ${evt}`;
const life = (evt) => `${node} ${lifecycleDest} ${evt}`;

let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const bak = settingsPath + ".bak-statusbar";
  if (!fs.existsSync(bak)) fs.copyFileSync(settingsPath, bak);
}
settings.hooks = settings.hooks || {};

const stripOurs = (arr) =>
  (arr || [])
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((h) => !(h.command || "").includes(MARKER)),
    }))
    .filter((entry) => (entry.hooks || []).length > 0);

const addUnmatched = (evt, command) => {
  settings.hooks[evt] = stripOurs(settings.hooks[evt]);
  settings.hooks[evt].push({ hooks: [{ type: "command", command }] });
};
const addMatched = (evt, command) => {
  settings.hooks[evt] = stripOurs(settings.hooks[evt]);
  settings.hooks[evt].push({ matcher: "*", hooks: [{ type: "command", command }] });
};

// Status hooks (drive the animation/label)
addUnmatched("UserPromptSubmit", cmd("prompt"));
addMatched("PreToolUse", cmd("pre"));
addMatched("PostToolUse", cmd("post"));
addUnmatched("Notification", cmd("notify"));
addMatched("PermissionRequest", cmd("permreq"));
addUnmatched("Stop", cmd("stop"));
// Lifecycle hooks (launch the app on open; the app quits itself when no longer needed)
addUnmatched("SessionStart", life("start"));
addUnmatched("SessionEnd", life("end"));

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("Installed status-bar hooks into", settingsPath);
console.log("Scripts:", updateDest, "and", lifecycleDest);
console.log("Backup (first run only):", settingsPath + ".bak-statusbar");

// Codex auto-launch (optional): points ~/.codex/hooks.json's SessionStart at codex-lifecycle.js,
// which only launches the app (never writes session state — Codex's env lacks the Claude vars,
// and the app discovers Codex sessions itself by polling rollout logs). Skipped silently when
// ~/.codex doesn't exist. Idempotent: only our own entry (identified by the codex-lifecycle.js
// basename in its command) is replaced; every other Codex hook is left untouched.
const codexDir = path.join(home, ".codex");
if (fs.existsSync(codexDir)) {
  const codexLifecycleDest = path.join(sbDir, "codex-lifecycle.js");
  fs.copyFileSync(path.join(__dirname, "codex-lifecycle.js"), codexLifecycleDest);
  const codexHooksPath = path.join(codexDir, "hooks.json");
  const CODEX_MARKER = "codex-lifecycle.js";

  let codexHooks = {};
  if (fs.existsSync(codexHooksPath)) {
    try { codexHooks = JSON.parse(fs.readFileSync(codexHooksPath, "utf8")); } catch { codexHooks = {}; }
    const codexBak = codexHooksPath + ".bak-statusbar";
    if (!fs.existsSync(codexBak)) fs.copyFileSync(codexHooksPath, codexBak);
  }
  // process.execPath is a version-pinned Homebrew path (…/Cellar/node/<ver>/bin/node) that a
  // `brew upgrade node` retires, silently breaking the hook. For Codex (which we may relaunch long
  // after install) prefer a stable symlink that resolves to this same binary.
  const codexNode = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find((p) => {
    try { return fs.realpathSync(p) === process.execPath; } catch { return false; }
  }) || process.execPath;

  codexHooks.hooks = codexHooks.hooks || {};
  codexHooks.hooks.SessionStart = (codexHooks.hooks.SessionStart || [])
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((h) => !(h.command || "").includes(CODEX_MARKER)),
    }))
    .filter((entry) => (entry.hooks || []).length > 0);
  codexHooks.hooks.SessionStart.push({ hooks: [{ type: "command", command: `${codexNode} ${codexLifecycleDest}` }] });

  fs.writeFileSync(codexHooksPath, JSON.stringify(codexHooks, null, 2) + "\n");
  console.log("Installed Codex launch hook into", codexHooksPath);
}

// Codex auto-launch guardian (LaunchAgent). The Codex app is the ChatGPT desktop app
// (com.openai.codex), which does NOT execute ~/.codex/hooks.json, so a hook cannot launch us when
// you open Codex without Claude. This agent polls on a short interval and launches the app whenever
// Codex is open and the app is not already running; the app self-quits once neither Codex nor Claude
// is around. Skipped when neither ~/.codex nor ChatGPT.app is present.
if (fs.existsSync(codexDir) || fs.existsSync("/Applications/ChatGPT.app")) {
  const watchDest = path.join(sbDir, "codex-watch.js");
  fs.copyFileSync(path.join(__dirname, "codex-watch.js"), watchDest);
  const guardNode = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find((p) => {
    try { return fs.realpathSync(p) === process.execPath; } catch { return false; }
  }) || process.execPath;
  const CODEXWATCH_LABEL = "com.local.claudestatusbar.codexwatch";
  const plistPath = path.join(home, "Library", "LaunchAgents", CODEXWATCH_LABEL + ".plist");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CODEXWATCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${guardNode}</string>
    <string>${watchDest}</string>
  </array>
  <key>StartInterval</key><integer>15</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  const uid = process.getuid();
  try { cp.execSync(`launchctl bootout gui/${uid}/${CODEXWATCH_LABEL}`, { stdio: "ignore" }); } catch {}
  try { cp.execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: "ignore" }); } catch {}
  console.log("Installed Codex launch guardian:", plistPath);
}
