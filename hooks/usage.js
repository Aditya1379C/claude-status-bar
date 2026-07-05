#!/usr/bin/env node
// Claude Code statusLine script: captures plan usage (5h/7d) from the stdin JSON into
// ~/.claude/statusbar/usage.json for the menu bar app to poll, and prints a compact status line.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = path.join(os.homedir(), ".claude", "statusbar");
const outPath = path.join(dir, "usage.json");

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let line = "";
  try {
    let p = {};
    try { p = JSON.parse(raw || "{}"); } catch {}

    const rl = p.rate_limits || null;
    const fiveHourPct = rl && rl.five_hour && rl.five_hour.used_percentage != null
      ? Math.round(rl.five_hour.used_percentage) : null;
    const fiveHourResetsAt = rl && rl.five_hour && rl.five_hour.resets_at != null
      ? rl.five_hour.resets_at : null;
    const sevenDayPct = rl && rl.seven_day && rl.seven_day.used_percentage != null
      ? Math.round(rl.seven_day.used_percentage) : null;
    const sevenDayResetsAt = rl && rl.seven_day && rl.seven_day.resets_at != null
      ? rl.seven_day.resets_at : null;

    const out = {
      fiveHour: { pct: fiveHourPct, resetsAt: fiveHourResetsAt },
      sevenDay: { pct: sevenDayPct, resetsAt: sevenDayResetsAt },
      ts: Math.floor(Date.now() / 1000),
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = outPath + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, outPath);
    } catch {}

    const modelName = (p.model && p.model.display_name) || "";
    const ctxPct = p.context_window && p.context_window.used_percentage != null
      ? p.context_window.used_percentage : null;

    const segments = [];
    if (modelName) segments.push(modelName);
    if (ctxPct != null) segments.push(`ctx ${ctxPct}%`);
    if (fiveHourPct != null) segments.push(`5h ${fiveHourPct}%`);
    if (sevenDayPct != null) segments.push(`7d ${sevenDayPct}%`);
    line = segments.join(" · ");
  } catch {
    // Never let a bug here break the CLI's status line.
  }
  process.stdout.write(line);
});
