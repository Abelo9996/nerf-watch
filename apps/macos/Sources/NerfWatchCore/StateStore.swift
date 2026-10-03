import Foundation

/// The small state file kept between runs, in
/// `~/Library/Application Support/NerfWatch/state.json`.
/// It holds only finding keys (detector, agent, model, CLI version), counts and dates.
public struct PersistedState: Codable, Equatable, Sendable {
    public var version: Int = 1
    /// Alert keys from the last successful run. `nil` until the first one.
    public var alertKeys: [String]?
    public var lastSuccess: Date?
    public var lastCounts: SeverityCounts?

    public init(alertKeys: [String]? = nil, lastSuccess: Date? = nil, lastCounts: SeverityCounts? = nil) {
        self.alertKeys = alertKeys
        self.lastSuccess = lastSuccess
        self.lastCounts = lastCounts
    }
}

public struct StateStore: Sendable {
    public let fileURL: URL

    public init(directory: URL) {
        fileURL = directory.appendingPathComponent("state.json")
    }

    /// `~/Library/Application Support/NerfWatch`, or `NERF_WATCH_STATE_DIR` when set (for tests and demos).
    public static func defaultDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let dir = environment["NERF_WATCH_STATE_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: (dir as NSString).expandingTildeInPath, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("NerfWatch", isDirectory: true)
    }

    public func load() -> PersistedState {
        guard let data = try? Data(contentsOf: fileURL) else { return PersistedState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(PersistedState.self, from: data)) ?? PersistedState()
    }

    public func save(_ state: PersistedState) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(state).write(to: fileURL, options: .atomic)
    }

    /// Apply a successful run: returns the alerts that are new, and stores the current alert keys.
    /// Failed runs must not call this, so an error never resets what counts as "new".
    @discardableResult
    public func record(_ result: CheckResult, at date: Date = Date()) -> [Finding] {
        var state = load()
        let previous = state.alertKeys.map(Set.init)
        let fresh = AlertDiff.newAlerts(current: result.findings, previousKeys: previous)
        state.alertKeys = AlertDiff.alertKeys(result.findings).sorted()
        state.lastSuccess = date
        state.lastCounts = result.counts
        try? save(state)
        return fresh
    }
}
