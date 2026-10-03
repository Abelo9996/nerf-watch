import Foundation

/// Text used in the menu, tooltip and notifications. Kept here so it can be tested
/// and so status is always expressed in words, not only by color.
public enum Formatting {
    /// "CLI 2.1.270, 2.1.271 → 2.1.272", "CLI 0.141.0 (same version)" or "CLI 2.1.272".
    public static func versionRange(_ f: Finding) -> String {
        let before = f.evidence.first { $0.label == "before" }?.versions ?? []
        let after = f.evidence.first { $0.label == "after" }?.versions ?? []
        if f.trigger == "version", !before.isEmpty, !after.isEmpty {
            return "CLI \(compact(before)) → \(compact(after))"
        }
        if f.trigger == "time", !after.isEmpty {
            return "CLI \(compact(after)) (same version)"
        }
        var all: [String] = []
        for v in f.evidence.flatMap({ $0.versions ?? [] }) where !all.contains(v) { all.append(v) }
        return all.isEmpty ? "" : "CLI \(compact(all))"
    }

    /// Up to two versions are listed; longer runs show the ends.
    static func compact(_ versions: [String]) -> String {
        switch versions.count {
        case 0: return ""
        case 1, 2: return versions.joined(separator: ", ")
        default: return "\(versions[0]) to \(versions[versions.count - 1])"
        }
    }

    /// "2026-08-23 to 2026-10-01", spanning all evidence.
    public static func dateRange(_ f: Finding) -> String {
        let froms = f.evidence.compactMap(\.from).sorted()
        let tos = f.evidence.compactMap(\.to).sorted()
        guard let from = froms.first, let to = tos.last else { return "" }
        return from == to ? from : "\(from) to \(to)"
    }

    /// "claude · claude-opus-5 · CLI 2.1.270, 2.1.271 → 2.1.272"
    public static func subtitle(_ f: Finding) -> String {
        [f.agent, f.model ?? "", versionRange(f)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// "2 alerts, 3 warnings", "No changes found", ...
    public static func summary(_ counts: SeverityCounts) -> String {
        var parts: [String] = []
        if counts.alert > 0 { parts.append(plural(counts.alert, "alert")) }
        if counts.warn > 0 { parts.append(plural(counts.warn, "warning")) }
        if parts.isEmpty { return counts.info > 0 ? "No changes found (\(plural(counts.info, "note")))" : "No changes found" }
        return parts.joined(separator: ", ")
    }

    public static func plural(_ n: Int, _ word: String) -> String {
        "\(n) \(word)\(n == 1 ? "" : "s")"
    }

    /// Word for the status light, used in the tooltip and accessibility label.
    public static func statusWord(_ status: Status) -> String {
        switch status {
        case .unknown: return "Not checked"
        case .ok: return "OK"
        case .warn: return "Warning"
        case .alert: return "Alert"
        }
    }

    /// Notification body for new alerts.
    public static func notification(for alerts: [Finding]) -> (title: String, body: String)? {
        guard let first = alerts.first else { return nil }
        let title = alerts.count == 1 ? "New nerf-watch alert" : "\(alerts.count) new nerf-watch alerts"
        var body = "\(first.title) (\(subtitle(first)))"
        if alerts.count > 1 { body += " and \(alerts.count - 1) more" }
        return (title, body)
    }
}
