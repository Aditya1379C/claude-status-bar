import Cocoa

// Codex CLI integration: no hooks, no network — this polls ~/.codex's on-disk rollout logs
// (appended live during CLI/TUI use) the same way the rest of the app polls state.d. See
// PLAN.md "Data source" for the verified on-disk shapes this file parses.

struct CodexWindow {
    let usedPercent: Double
    let windowMinutes: Int
    let resetsAt: Double   // real wall-clock unix seconds
}

extension StatusController {

    // MARK: session discovery

    // Refreshes `codexSessions` from ~/.codex/sessions, re-tailing only rollout files whose mtime
    // changed. Rebuilt fresh every call (never additive) so a session that ages out of the
    // retention window simply stops appearing — Codex sessions are never pid-reaped.
    func reloadCodexSessions() {
        let fm = FileManager.default
        let nowTs = Date().timeIntervalSince1970

        reloadCodexNamesIfNeeded()

        let candidates = codexCandidateRollouts()
        let retain = max(stalePruneAge, codexActiveWindow)

        var newSessions: [String: Session] = [:]
        var newMTimes: [String: Date] = [:]

        for path in candidates {
            guard let attrs = try? fm.attributesOfItem(atPath: path),
                  let mtime = attrs[.modificationDate] as? Date else { continue }
            let mtimeTs = mtime.timeIntervalSince1970
            // stalePruneAge == 0 means "Never" — keep anything from the two scanned day dirs.
            if stalePruneAge > 0 && nowTs - mtimeTs > retain { continue }

            let filename = (path as NSString).lastPathComponent
            guard let id = codexSessionId(fromFilename: filename) else { continue }

            // A reused (mtime-unchanged) session carries its rate-limit fields forward automatically,
            // since they live on the Session — so a session that goes quiet keeps its last reading.
            var session: Session
            if codexFileMTimes[path] == mtime, let existing = codexSessions[id] {
                session = existing
            } else if let parsed = parseCodexRollout(path: path, id: id) {
                session = parsed
            } else {
                continue
            }

            session.ts = mtimeTs
            // Working = a recent write AND the turn hasn't ended. The completion marker snaps a
            // finished turn straight to idle even though the file was just written, so the icon does
            // not keep animating for a full window after Codex is done.
            let recent = nowTs - mtimeTs <= codexActiveWindow
            let eff = (recent && !session.codexTurnComplete) ? "thinking" : "idle"
            session.eff = eff
            session.state = eff

            newSessions[id] = session
            newMTimes[path] = mtime
        }

        codexSessions = newSessions
        codexFileMTimes = newMTimes
    }

    // Rebuilds codexNames from ~/.codex/session_index.jsonl only when its mtime changed.
    // Malformed lines are tolerated (best-effort name lookup, not every session is listed).
    private func reloadCodexNamesIfNeeded() {
        let path = (codexDir as NSString).appendingPathComponent("session_index.jsonl")
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let m = attrs[.modificationDate] as? Date else { return }
        guard codexNamesMTime != m else { return }
        codexNamesMTime = m
        var names: [String: String] = [:]
        if let data = FileManager.default.contents(atPath: path) {
            let s = String(decoding: data, as: UTF8.self)
            for line in s.split(separator: "\n") {
                guard let ldata = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: ldata) as? [String: Any],
                      let id = obj["id"] as? String,
                      let name = obj["thread_name"] as? String, !name.isEmpty else { continue }
                names[id] = name
            }
        }
        codexNames = names
    }

    // All rollout files under sessions/, recursively. A long-lived Codex thread keeps appending to
    // the rollout in its ORIGINAL start-date dir, so a date-windowed scan (today/yesterday) misses a
    // days-old session that is still active right now. The mtime filter in reloadCodexSessions is
    // what limits us to recent ones; discovery just needs to see every file. Cheap: the tree holds a
    // few dozen files and we only stat, never read, here.
    private func codexCandidateRollouts() -> [String] {
        let fm = FileManager.default
        let sessionsRoot = (codexDir as NSString).appendingPathComponent("sessions")
        guard let en = fm.enumerator(atPath: sessionsRoot) else { return [] }
        var paths: [String] = []
        for case let sub as String in en {
            let name = (sub as NSString).lastPathComponent
            guard name.hasPrefix("rollout-"), name.hasSuffix(".jsonl") else { continue }
            paths.append((sessionsRoot as NSString).appendingPathComponent(sub))
        }
        return paths
    }

    // uuid is a fixed-length (36-char) standard UUID string always at the very end of the
    // filename (rollout-<startTs>-<uuid>.jsonl); the timestamp prefix's own format doesn't matter.
    private func codexSessionId(fromFilename filename: String) -> String? {
        guard filename.hasPrefix("rollout-"), filename.hasSuffix(".jsonl") else { return nil }
        let stripped = filename.dropFirst("rollout-".count).dropLast(".jsonl".count)
        guard stripped.count >= 36 else { return nil }
        return String(stripped.suffix(36))
    }

    // Reads line 0 (session_meta, best-effort cwd) and tails ~64KB for the freshest token_count
    // event_msg, scanning from the end so the FIRST match found is the most recent. Torn/truncated
    // tail lines fail their JSON parse and are skipped; a lossy UTF-8 decode means a split leading
    // multibyte char never drops the whole read (mirrors contextTokens(ofFileAt:)).
    private func parseCodexRollout(path: String, id: String) -> Session? {
        guard let fh = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0

        var cwd = ""
        let headChunk: UInt64 = 64 * 1024
        try? fh.seek(toOffset: 0)
        if let headData = try? fh.read(upToCount: Int(min(size, headChunk))) {
            let headStr = String(decoding: headData, as: UTF8.self)
            if let firstLine = headStr.split(separator: "\n").first,
               let ldata = firstLine.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: ldata) as? [String: Any],
               obj["type"] as? String == "session_meta",
               let payload = obj["payload"] as? [String: Any] {
                cwd = payload["cwd"] as? String ?? ""
            }
        }

        let tailChunk: UInt64 = 64 * 1024
        try? fh.seek(toOffset: size > tailChunk ? size - tailChunk : 0)
        guard let tailData = try? fh.readToEnd() else { return nil }
        let tailStr = String(decoding: tailData, as: UTF8.self)

        var tokens: Int? = nil
        var ctxWindow: Int? = nil
        var primaryWindow: CodexWindow? = nil
        var secondaryWindow: CodexWindow? = nil

        for line in tailStr.split(separator: "\n").reversed() {
            guard line.contains("token_count") else { continue }
            guard let ldata = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: ldata) as? [String: Any],
                  obj["type"] as? String == "event_msg",
                  let payload = obj["payload"] as? [String: Any],
                  payload["type"] as? String == "token_count" else { continue }
            if let info = payload["info"] as? [String: Any] {
                // last_token_usage is the most recent request's tokens = what's currently in the
                // context window. total_token_usage is the session's CUMULATIVE lifetime spend
                // (grows unbounded, dwarfs the window), which is not "context size".
                if let usage = info["last_token_usage"] as? [String: Any] {
                    tokens = (usage["total_tokens"] as? NSNumber)?.intValue
                }
                ctxWindow = (info["model_context_window"] as? NSNumber)?.intValue
            }
            if let rl = payload["rate_limits"] as? [String: Any],
               let p = rl["primary"] as? [String: Any], let primary = codexWindow(from: p) {
                primaryWindow = primary
                secondaryWindow = (rl["secondary"] as? [String: Any]).flatMap(codexWindow(from:))
            }
            break   // first hit scanning backward = most recent
        }

        var s = Session(json: [:], id: id)
        s.source = .codex
        s.transcript = path
        s.cwd = cwd
        s.branch = branchForCwd(cwd)
        let looked = codexNames[id] ?? (cwd as NSString).lastPathComponent
        let resolvedName = looked.isEmpty ? "codex" : looked
        s.project = resolvedName
        s.displayName = resolvedName
        s.codexTokens = tokens
        s.codexCtxWindow = ctxWindow
        s.codexPrimary = primaryWindow
        s.codexSecondary = secondaryWindow
        s.codexTurnComplete = codexTurnIsComplete(tailStr)
        return s
    }

    // A turn is "complete" (Codex is idle, waiting for input) when the file's last event is a
    // completion/idle marker; while generating or running tools the last event is a streaming item,
    // so "not complete" plus a recent write means working. Defaults to complete (idle) when the last
    // line is unparseable, so a torn tail never fakes activity.
    private func codexTurnIsComplete(_ tailStr: String) -> Bool {
        guard let last = tailStr.split(separator: "\n").last(where: { !$0.isEmpty }),
              let d = last.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return true }
        let t = ((o["payload"] as? [String: Any])?["type"] as? String) ?? (o["type"] as? String) ?? ""
        let done: Set<String> = ["task_complete", "turn_complete", "turn_aborted", "turn.completed", "session_end", "session_meta"]
        return done.contains(t)
    }

    private func codexWindow(from dict: [String: Any]) -> CodexWindow? {
        guard let used = dict["used_percent"] as? NSNumber,
              let mins = dict["window_minutes"] as? NSNumber,
              let resets = dict["resets_at"] as? NSNumber else { return nil }
        return CodexWindow(usedPercent: used.doubleValue, windowMinutes: mins.intValue, resetsAt: resets.doubleValue)
    }

    // MARK: menu rendering helpers

    // Context-usage row for a Codex session: tokens only when the context window is unknown
    // (never a fabricated denominator), tokens/window · pct once it is. [] when no token_count
    // line was ever found (mirrors contextInfoRows' "no placeholder" rule).
    func codexContextRows(for s: Session) -> [NSMenuItem] {
        guard let tokens = s.codexTokens else { return [] }
        if let window = s.codexCtxWindow, window > 0 {
            let pct = Int((Double(tokens) / Double(window) * 100).rounded())
            return [infoRow(label: "Context size", value: "\(compactTokens(tokens)) / \(compactTokens(window)) · \(pct)%")]
        }
        return [infoRow(label: "Context size", value: compactTokens(tokens))]
    }

    private func codexWindowName(_ minutes: Int) -> String {
        switch minutes {
        case 300:   return "5h"
        case 1440:  return "daily"
        case 10080: return "weekly"
        case 43200: return "monthly"
        default:    return "\(minutes / 60)h"
        }
    }

    // Live countdown against the real resets_at, never a stale absolute reading. Tiered by magnitude
    // so a weekly/monthly window reads in days (not an unwieldy "140h") while a 5h window stays in
    // minutes/hours.
    private func codexResetCaption(_ resetsAt: Double) -> String {
        let secs = max(0, resetsAt - Date().timeIntervalSince1970)
        if secs < 3600 { return "resets in \(max(1, Int(secs / 60)))m" }
        if secs < 86400 { return "resets in \(Int(secs / 3600))h" }
        return "resets in \(Int(secs / 86400))d"
    }

    // One disabled gauge row: window name, a filled track (brand fill / tertiary track), and a
    // right caption "P% · resets in Xh".
    func codexGaugeRow(_ window: CodexWindow) -> NSMenuItem {
        let width = CGFloat(uiConfig()["boxWidth"] ?? 300)
        let caption = "\(Int(window.usedPercent.rounded()))% · " + codexResetCaption(window.resetsAt)
        let view = GaugeRowView(width: width, windowName: codexWindowName(window.windowMinutes),
                                 usedPercent: window.usedPercent, caption: caption, fillColor: brand)
        let it = NSMenuItem()
        it.isEnabled = false
        it.view = view
        return it
    }
}

// Disabled menu-row custom view for a Codex rate-limit gauge: left label (window name), a
// rounded filled track in the middle, and a right caption. Left inset (x=38) matches infoRow's
// label column so gauge rows read as part of the same "Sessions" list.
final class GaugeRowView: NSView {
    init(width: CGFloat, windowName: String, usedPercent: Double, caption: String, fillColor: NSColor) {
        let height: CGFloat = 26
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: height))
        autoresizingMask = [.width]

        let smallFont = NSFont.menuFont(ofSize: NSFont.menuFont(ofSize: 0).pointSize - 1)
        let leftInset: CGFloat = 38, rightInset: CGFloat = 12, nameW: CGFloat = 54, captionW: CGFloat = 150, gap: CGFloat = 8

        let nameLabel = NSTextField(labelWithString: windowName)
        nameLabel.font = smallFont
        nameLabel.textColor = .secondaryLabelColor
        nameLabel.frame = NSRect(x: leftInset, y: (height - 16) / 2, width: nameW, height: 16)
        addSubview(nameLabel)

        let captionLabel = NSTextField(labelWithString: caption)
        captionLabel.font = NSFont.monospacedDigitSystemFont(ofSize: smallFont.pointSize, weight: .regular)
        captionLabel.textColor = .secondaryLabelColor
        captionLabel.alignment = .right
        captionLabel.frame = NSRect(x: width - rightInset - captionW, y: (height - 16) / 2, width: captionW, height: 16)
        captionLabel.autoresizingMask = [.minXMargin]
        addSubview(captionLabel)

        let trackX = leftInset + nameW + gap
        let trackW = max(0, width - rightInset - captionW - gap - trackX)
        let trackH: CGFloat = 6
        let track = NSView(frame: NSRect(x: trackX, y: (height - trackH) / 2, width: trackW, height: trackH))
        track.wantsLayer = true
        track.layer?.backgroundColor = NSColor.tertiaryLabelColor.withAlphaComponent(0.3).cgColor
        track.layer?.cornerRadius = trackH / 2
        track.autoresizingMask = [.width]
        addSubview(track)

        let frac = max(0, min(1, usedPercent / 100))
        let fill = NSView(frame: NSRect(x: trackX, y: (height - trackH) / 2, width: trackW * CGFloat(frac), height: trackH))
        fill.wantsLayer = true
        fill.layer?.backgroundColor = fillColor.cgColor
        fill.layer?.cornerRadius = trackH / 2
        addSubview(fill)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
