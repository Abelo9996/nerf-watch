import Foundation
import Testing
@testable import NerfWatchCore

private func shift(_ id: String, after: [String], before: [String] = ["1.0.0"], severity: Severity = .alert, model: String = "m", title: String? = nil) -> Finding {
    Finding(
        detector: id, severity: severity, agent: "claude", model: model,
        title: title ?? "\(id) after CLI \(after.first ?? "")",
        evidence: [
            Evidence(label: "before", versions: before, display: "1"),
            Evidence(label: "after", versions: after, display: "2"),
        ],
        trigger: "version"
    )
}

private func event(_ title: String, severity: Severity = .alert) -> Finding {
    Finding(detector: "model-mismatch", severity: severity, agent: "claude", model: "claude-sonnet-5", title: title, trigger: "event")
}

@Suite struct AlertDiffTests {
    @Test func everyAlertIsNewWithoutAPreviousRun() {
        let current = [shift("a", after: ["2.0.0"]), shift("b", after: ["2.0.0"], severity: .warn)]
        #expect(AlertDiff.newAlerts(current: current, previousKeys: nil).map(\.detector) == ["a"])
    }

    @Test func sameAlertAgainIsNotNew() {
        let current = [shift("a", after: ["2.0.0"])]
        let previous = AlertDiff.alertKeys(current)
        #expect(AlertDiff.newAlerts(current: current, previousKeys: previous).isEmpty)
    }

    @Test func titleChangeFromPoolingMoreVersionsIsNotNew() {
        let before = [shift("cacheCreation-shift", after: ["2.1.272"], title: "Cache writes jumped after CLI 2.1.272")]
        let after = [shift("cacheCreation-shift", after: ["2.1.272", "2.1.273"], title: "Cache writes jumped between CLI 2.1.272 and 2.1.273")]
        #expect(AlertDiff.newAlerts(current: after, previousKeys: AlertDiff.alertKeys(before)).isEmpty)
    }

    @Test func aRegressionAtANewVersionIsNew() {
        let previous = AlertDiff.alertKeys([shift("a", after: ["2.0.0"])])
        let current = [shift("a", after: ["2.0.0"]), shift("a", after: ["3.0.0"], before: ["2.0.0"])]
        let fresh = AlertDiff.newAlerts(current: current, previousKeys: previous)
        #expect(fresh.count == 1)
        #expect(fresh.first?.evidence.last?.versions == ["3.0.0"])
    }

    @Test func differentModelOrAgentIsNew() {
        let previous = AlertDiff.alertKeys([shift("a", after: ["2.0.0"], model: "m1")])
        #expect(AlertDiff.newAlerts(current: [shift("a", after: ["2.0.0"], model: "m2")], previousKeys: previous).count == 1)
        var codex = shift("a", after: ["2.0.0"], model: "m1")
        codex.agent = "codex"
        #expect(AlertDiff.newAlerts(current: [codex], previousKeys: previous).count == 1)
    }

    @Test func warningEscalatingToAlertIsNew() {
        let previous = AlertDiff.alertKeys([shift("a", after: ["2.0.0"], severity: .warn)])
        #expect(previous.isEmpty)
        #expect(AlertDiff.newAlerts(current: [shift("a", after: ["2.0.0"])], previousKeys: previous).count == 1)
    }

    @Test func warningsAndInfoNeverNotify() {
        let current = [shift("a", after: ["2.0.0"], severity: .warn), event("Fell back from a to b (3x)", severity: .info)]
        #expect(AlertDiff.newAlerts(current: current, previousKeys: []).isEmpty)
    }

    @Test func eventKeysIgnoreRunningCounts() {
        #expect(AlertDiff.key(for: event("Fell back from a to b (3x)")) == AlertDiff.key(for: event("Fell back from a to b (12x)")))
        #expect(AlertDiff.key(for: event("Requested claude-opus-5 but claude-sonnet-5 answered"))
                != AlertDiff.key(for: event("Requested claude-haiku-5 but claude-sonnet-5 answered")))
    }

    @Test func duplicateKeysInOneRunNotifyOnce() {
        let a = event("Requested x but y answered")
        #expect(AlertDiff.newAlerts(current: [a, a], previousKeys: nil).count == 1)
    }

    @Test func alertThatWentAwayAndCameBackIsNewAgain() {
        let a = [shift("a", after: ["2.0.0"])]
        let afterQuietRun = AlertDiff.alertKeys([])
        #expect(AlertDiff.newAlerts(current: a, previousKeys: afterQuietRun).count == 1)
    }

    @Test func demoOutputKeys() throws {
        guard case .result(let r) = CheckParser.parseJSON(Data(demoCheckJSON.utf8)) else {
            Issue.record("demo fixture did not parse"); return
        }
        #expect(AlertDiff.alertKeys(r.findings) == [
            "model-mismatch|claude|claude-sonnet-5|Requested claude-opus-5 but claude-sonnet-5 answered",
            "cacheCreation-shift|claude|claude-opus-5|2.1.272",
        ])
    }
}

@Suite struct StateStoreTests {
    private func tempStore() throws -> StateStore {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nerf-watch-tests-\(UUID().uuidString)")
        return StateStore(directory: dir)
    }

    @Test func recordsAlertKeysAndReportsOnlyNewOnes() throws {
        let store = try tempStore()
        defer { try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent()) }
        #expect(store.load().alertKeys == nil)

        let first = CheckResult(findings: [shift("a", after: ["2.0.0"])])
        #expect(store.record(first).count == 1)
        #expect(store.load().alertKeys == ["a|claude|m|2.0.0"])
        #expect(store.load().lastCounts == SeverityCounts(alert: 1))

        #expect(store.record(first).isEmpty)

        let second = CheckResult(findings: [shift("a", after: ["2.0.0"]), shift("b", after: ["2.0.0"])])
        #expect(store.record(second).map(\.detector) == ["b"])

        // A clean run clears the keys, so a returning alert notifies again.
        #expect(store.record(CheckResult(findings: [])).isEmpty)
        #expect(store.load().alertKeys == [])
        #expect(store.record(first).count == 1)
    }

    @Test func corruptStateFileStartsFresh() throws {
        let store = try tempStore()
        defer { try? FileManager.default.removeItem(at: store.fileURL.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("garbage".utf8).write(to: store.fileURL)
        #expect(store.load() == PersistedState())
        #expect(store.record(CheckResult(findings: [shift("a", after: ["2.0.0"])])).count == 1)
    }

    @Test func environmentOverridesDirectory() {
        let url = StateStore.defaultDirectory(environment: ["NERF_WATCH_STATE_DIR": "/tmp/nw-state"])
        #expect(url.path == "/tmp/nw-state")
        #expect(StateStore.defaultDirectory(environment: [:]).path.hasSuffix("Application Support/NerfWatch"))
    }
}
