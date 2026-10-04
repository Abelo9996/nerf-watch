import Foundation

/// Severity levels used by `nerf-watch check --json`.
public enum Severity: String, Sendable, Codable, Comparable, CaseIterable {
    case info, warn, alert

    private var rank: Int {
        switch self {
        case .info: return 0
        case .warn: return 1
        case .alert: return 2
        }
    }

    public static func < (lhs: Severity, rhs: Severity) -> Bool { lhs.rank < rhs.rank }

    /// Short uppercase label, matching the CLI's text output.
    public var label: String {
        switch self {
        case .info: return "INFO"
        case .warn: return "WARN"
        case .alert: return "ALERT"
        }
    }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // Unknown severities from a newer CLI are shown, but never as alerts.
        self = Severity(rawValue: raw.lowercased()) ?? .info
    }
}

/// One side of a comparison ("before" / "after", "requested" / "served", "events").
public struct Evidence: Sendable, Codable, Equatable, Hashable {
    public var label: String
    public var versions: [String]?
    public var from: String?
    public var to: String?
    public var samples: Double?
    /// What `samples` counts ("turns", "sessions", "tool calls"). Older CLIs omit it.
    public var sampleUnit: String?
    public var value: Double?
    public var display: String

    public init(label: String, versions: [String]? = nil, from: String? = nil, to: String? = nil, samples: Double? = nil, sampleUnit: String? = nil, value: Double? = nil, display: String) {
        self.label = label
        self.versions = versions
        self.from = from
        self.to = to
        self.samples = samples
        self.sampleUnit = sampleUnit
        self.value = value
        self.display = display
    }

    private enum CodingKeys: String, CodingKey { case label, versions, from, to, samples, sampleUnit, value, display }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = (try? c.decode(String.self, forKey: .label)) ?? ""
        versions = try? c.decodeIfPresent([String].self, forKey: .versions)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        to = try? c.decodeIfPresent(String.self, forKey: .to)
        samples = try? c.decodeIfPresent(Double.self, forKey: .samples)
        sampleUnit = try? c.decodeIfPresent(String.self, forKey: .sampleUnit)
        value = try? c.decodeIfPresent(Double.self, forKey: .value)
        display = (try? c.decode(String.self, forKey: .display)) ?? ""
    }
}

/// One finding from `nerf-watch check --json`.
public struct Finding: Sendable, Codable, Equatable, Hashable, Identifiable {
    public var id: String { key }
    /// Detector id, for example `cacheCreation-shift`.
    public var detector: String
    public var severity: Severity
    public var agent: String
    public var model: String?
    public var title: String
    public var explanation: String
    public var evidence: [Evidence]
    /// What to check or do next. Older CLIs omit it.
    public var nextStep: String?
    /// "version", "time" or "event".
    public var trigger: String

    public init(detector: String, severity: Severity, agent: String, model: String? = nil, title: String, explanation: String = "", evidence: [Evidence] = [], nextStep: String? = nil, trigger: String) {
        self.detector = detector
        self.severity = severity
        self.agent = agent
        self.model = model
        self.title = title
        self.explanation = explanation
        self.evidence = evidence
        self.nextStep = nextStep
        self.trigger = trigger
    }

    private enum CodingKeys: String, CodingKey {
        case detector = "id"
        case severity, agent, model, title, explanation, evidence, nextStep, trigger
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        detector = try c.decode(String.self, forKey: .detector)
        severity = (try? c.decode(Severity.self, forKey: .severity)) ?? .info
        agent = (try? c.decode(String.self, forKey: .agent)) ?? "unknown"
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        title = (try? c.decode(String.self, forKey: .title)) ?? detector
        explanation = (try? c.decode(String.self, forKey: .explanation)) ?? ""
        evidence = (try? c.decode([Evidence].self, forKey: .evidence)) ?? []
        nextStep = try? c.decodeIfPresent(String.self, forKey: .nextStep)
        trigger = (try? c.decode(String.self, forKey: .trigger)) ?? "event"
    }

    /// Stable identity used to decide whether an alert is new. See `AlertDiff`.
    public var key: String { AlertDiff.key(for: self) }
}

public struct SeverityCounts: Sendable, Codable, Equatable {
    public var alert: Int
    public var warn: Int
    public var info: Int

    public init(alert: Int = 0, warn: Int = 0, info: Int = 0) {
        self.alert = alert
        self.warn = warn
        self.info = info
    }

    public init(_ findings: [Finding]) {
        self.init(
            alert: findings.filter { $0.severity == .alert }.count,
            warn: findings.filter { $0.severity == .warn }.count,
            info: findings.filter { $0.severity == .info }.count
        )
    }
}

/// A successful `check --json` run.
public struct CheckResult: Sendable, Equatable {
    public var findings: [Finding]
    public var counts: SeverityCounts

    public init(findings: [Finding]) {
        // Most severe first, keeping the CLI's order within a severity.
        self.findings = findings.enumerated()
            .sorted { a, b in a.element.severity != b.element.severity ? a.element.severity > b.element.severity : a.offset < b.offset }
            .map(\.element)
        self.counts = SeverityCounts(findings)
    }
}

/// The overall light shown in the menu bar.
public enum Status: String, Sendable, Codable, Equatable {
    /// Not run yet, running for the first time, or the last run failed.
    case unknown
    /// No warnings or alerts (info findings may exist).
    case ok
    case warn
    case alert

    public init(_ result: CheckResult) {
        if result.counts.alert > 0 { self = .alert }
        else if result.counts.warn > 0 { self = .warn }
        else { self = .ok }
    }
}
