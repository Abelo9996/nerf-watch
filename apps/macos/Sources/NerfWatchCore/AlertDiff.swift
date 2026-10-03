import Foundation

/// Decides which alerts are new compared with the previous successful run.
///
/// A finding's title can change while it describes the same regression: once more
/// CLI versions ship, "jumped after CLI 2.1.272" becomes "jumped between CLI 2.1.272
/// and 2.1.274", and fallback titles carry a running count. The key therefore uses
/// the detector id, agent, model and the CLI version where the change started, not
/// the full title.
public enum AlertDiff {
    public static func key(for f: Finding) -> String {
        [f.detector, f.agent, f.model ?? "", anchor(for: f)].joined(separator: "|")
    }

    static func anchor(for f: Finding) -> String {
        switch f.trigger {
        case "version", "time":
            // The first version on the "after" side is where the change began.
            let after = f.evidence.first { $0.label == "after" } ?? f.evidence.last
            return after?.versions?.first ?? stripCount(f.title)
        default:
            // Event findings (model mismatch, fallbacks) are identified by their title,
            // minus any trailing occurrence count such as "(3x)".
            return stripCount(f.title)
        }
    }

    static func stripCount(_ title: String) -> String {
        guard let range = title.range(of: #"\s*\(\d+x\)$"#, options: .regularExpression) else { return title }
        return String(title[..<range.lowerBound])
    }

    /// Keys of the alert-level findings in a result.
    public static func alertKeys(_ findings: [Finding]) -> Set<String> {
        Set(findings.filter { $0.severity == .alert }.map(key(for:)))
    }

    /// Alerts in `current` that were not alerts in the previous run.
    ///
    /// `previousKeys == nil` means there has never been a successful run, so every
    /// alert is new. A finding that was a warning before and is an alert now counts
    /// as new, because only alert keys are stored.
    public static func newAlerts(current: [Finding], previousKeys: Set<String>?) -> [Finding] {
        var seen = Set<String>()
        return current.filter { f in
            guard f.severity == .alert else { return false }
            let k = key(for: f)
            guard seen.insert(k).inserted else { return false }
            return !(previousKeys?.contains(k) ?? false)
        }
    }
}
