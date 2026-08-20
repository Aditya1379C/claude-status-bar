#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const home = os.homedir();
// Match the dir, not "update.js": the narrower marker used to orphan the lifecycle hooks.
const MARKER = path.join(home, ".claude", "statusbar");
const settingsPath = path.join(home, ".claude", "settings.json");

// Tear down the desktop watcher LaunchAgent (best-effort; safe if absent).
const AGENT_LABEL = "com.local.claudestatusbar.watcher";
const agentPlist = path.join(home, "Library", "LaunchAgents", AGENT_LABEL + ".plist");
try { cp.execSync(`launchctl bootout gui/${process.getuid()}/${AGENT_LABEL}`, { stdio: "ignore" }); } catch {}
if (fs.existsSync(agentPlist)) { fs.rmSync(agentPlist); console.log("Removed desktop watcher LaunchAgent."); }
try { cp.execSync("pkill -x ClaudeStatusBar", { stdio: "ignore" }); } catch {}

if (!fs.existsSync(settingsPath)) { console.log("No settings.json; nothing to do."); process.exit(0); }

const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const evt of Object.keys(settings.hooks || {})) {
  settings.hooks[evt] = (settings.hooks[evt] || [])
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !(h.command || "").includes(MARKER)) }))
    .filter((e) => (e.hooks || []).length > 0);
  if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("Removed status-bar hooks from", settingsPath);

// Remove only the Codex auto-launch entry install.js added, leaving every other Codex hook alone.
const codexHooksPath = path.join(home, ".codex", "hooks.json");
if (fs.existsSync(codexHooksPath)) {
  try {
    const codexHooks = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
    for (const evt of Object.keys(codexHooks.hooks || {})) {
      codexHooks.hooks[evt] = (codexHooks.hooks[evt] || [])
        .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !(h.command || "").includes("codex-lifecycle.js")) }))
        .filter((e) => (e.hooks || []).length > 0);
      if (codexHooks.hooks[evt].length === 0) delete codexHooks.hooks[evt];
    }
    fs.writeFileSync(codexHooksPath, JSON.stringify(codexHooks, null, 2) + "\n");
    console.log("Removed Codex launch hook from", codexHooksPath);
  } catch {}
}
