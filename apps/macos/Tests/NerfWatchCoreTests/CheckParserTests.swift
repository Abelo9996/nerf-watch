import Foundation
import Testing
@testable import NerfWatchCore

@Suite struct CheckParserTests {
    private func parse(_ json: String, exit: Int32 = 1, stderr: String = "") -> CheckOutcome {
        CheckParser.parse(stdout: Data(json.utf8), stderr: Data(stderr.utf8), exitCode: exit)
    }

    private func result(_ outcome: CheckOutcome) throws -> CheckResult {
        guard case .result(let r) = outcome else {
            Issue.record("expected a result, got \(outcome)")
            throw CancellationError()
        }
        return r
    }

    @Test func parsesDemoOutput() throws {
        let r = try result(parse(demoCheckJSON))
        #expect(r.findings.count == 5)
        #expect(r.counts == SeverityCounts(alert: 2, warn: 3, info: 0))
        #expect(Status(r) == .alert)

        let mismatch = try #require(r.findings.first { $0.detector == "model-mismatch" })
        #expect(mismatch.severity == .alert)
        #expect(mismatch.agent == "claude")
        #expect(mismatch.model == "claude-sonnet-5")
        #expect(mismatch.trigger == "event")
        #expect(mismatch.evidence.map(\.label) == ["requested", "served"])
        #expect(mismatch.evidence[1].display == "claude-sonnet-5 (120 turns)")
        #expect(mismatch.evidence[1].samples == 120)
        #expect(mismatch.evidence[1].value == 0.09375)

        let cache = try #require(r.findings.first { $0.detector == "cacheCreation-shift" })
        #expect(cache.evidence[0].versions == ["2.1.270", "2.1.271"])
        #expect(cache.evidence[1].display == "3,037")
        #expect(cache.evidence[0].from == "2026-08-23")
    }

    @Test func sortsMostSevereFirstAndKeepsOrderWithinSeverity() throws {
        let r = try result(parse(demoCheckJSON))
        #expect(r.findings.map(\.severity) == [.alert, .alert, .warn, .warn, .warn])
        #expect(r.findings.map(\.detector) == ["model-mismatch", "cacheCreation-shift", "cacheHitRate-shift", "effort-drop", "contextWindow-drift"])
    }

    @Test func noFindingsIsGreen() throws {
        let r = try result(parse(#"{"summary":{"alert":0,"warn":0,"info":0},"findings":[]}"#, exit: 0))
        #expect(r.findings.isEmpty)
        #expect(Status(r) == .ok)
    }

    @Test func infoOnlyIsGreenAndWarningIsYellow() throws {
        let info = try result(parse(#"{"findings":[{"id":"model-fallback","severity":"info","agent":"claude","title":"Fell back from a to b (2x)","explanation":"","evidence":[],"trigger":"event"}]}"#, exit: 0))
        #expect(Status(info) == .ok)
        let warn = try result(parse(#"{"findings":[{"id":"hidden-model","severity":"warn","agent":"codex","title":"x","explanation":"","evidence":[],"trigger":"event"}]}"#, exit: 0))
        #expect(Status(warn) == .warn)
    }

    @Test func noDataEnvelope() {
        let outcome = parse(#"{"error":"no-data","message":"No Claude Code or Codex session logs found."}"#, exit: 0)
        #expect(outcome == .noData(message: "No Claude Code or Codex session logs found."))
    }

    @Test func toleratesNoticesBeforeTheJSON() throws {
        let noisy = "npm warn exec The following package was not found and will be installed: nerf-watch@0.1.0\n" + demoCheckJSON
        #expect(try result(parse(noisy)).findings.count == 5)
    }

    @Test func toleratesMissingOptionalFieldsAndUnknownSeverity() throws {
        let json = #"{"findings":[{"id":"future-check","severity":"critical","agent":"gemini","title":"Something new","trigger":"version","evidence":[{"label":"after","display":"12"}]}],"extra":true}"#
        let r = try result(parse(json, exit: 0))
        let f = try #require(r.findings.first)
        #expect(f.severity == .info) // unknown severities never raise an alert
        #expect(f.model == nil)
        #expect(f.explanation == "")
        #expect(f.evidence.first?.versions == nil)
        #expect(f.evidence.first?.samples == nil)
    }

    @Test func usageErrorUsesStderr() {
        let outcome = parse("", exit: 2, stderr: "nerf-watch: --root expects agent=dir\n")
        #expect(outcome == .failure(.usage(message: "nerf-watch: --root expects agent=dir")))
    }

    @Test func missingNodeIsDetected() {
        let outcome = parse("", exit: 127, stderr: "env: node: No such file or directory\n")
        #expect(outcome == .failure(.nodeMissing))
        if case .failure(let f) = outcome { #expect(f.isNodeMissing) }
    }

    @Test func crashesAndGarbageAreFailures() {
        guard case .failure(.failed(let m1)) = parse("", exit: 3, stderr: "TypeError: boom\n    at x\n") else {
            Issue.record("expected failure"); return
        }
        #expect(m1.contains("code 3"))
        guard case .failure(.failed(let m2)) = parse("not json at all", exit: 0) else {
            Issue.record("expected failure"); return
        }
        #expect(m2.contains("no JSON"))
        guard case .failure(.failed) = parse("{\"findings\": [", exit: 1) else {
            Issue.record("expected failure"); return
        }
        guard case .failure(.failed) = parse("{\"summary\": {}}", exit: 0) else {
            Issue.record("expected failure"); return
        }
    }
}

@Suite struct FormattingTests {
    private var demo: [Finding] {
        guard case .result(let r) = CheckParser.parseJSON(Data(demoCheckJSON.utf8)) else { return [] }
        return r.findings
    }

    private func finding(_ id: String) -> Finding { demo.first { $0.detector == id }! }

    @Test func versionRanges() {
        #expect(Formatting.versionRange(finding("cacheCreation-shift")) == "CLI 2.1.270, 2.1.271 → 2.1.272")
        #expect(Formatting.versionRange(finding("effort-drop")) == "CLI 0.140.0 → 0.141.0")
        #expect(Formatting.versionRange(finding("contextWindow-drift")) == "CLI 0.141.0 (same version)")
        #expect(Formatting.versionRange(finding("model-mismatch")) == "CLI 2.1.272")
        #expect(Formatting.compact(["1", "2", "3", "4"]) == "1 to 4")
    }

    @Test func subtitleAndDates() {
        #expect(Formatting.subtitle(finding("model-mismatch")) == "claude · claude-sonnet-5 · CLI 2.1.272")
        #expect(Formatting.dateRange(finding("cacheCreation-shift")) == "2026-08-23 to 2026-10-01")
    }

    @Test func summaries() {
        #expect(Formatting.summary(SeverityCounts(alert: 2, warn: 3)) == "2 alerts, 3 warnings")
        #expect(Formatting.summary(SeverityCounts(alert: 1)) == "1 alert")
        #expect(Formatting.summary(SeverityCounts()) == "No changes found")
        #expect(Formatting.summary(SeverityCounts(info: 1)) == "No changes found (1 note)")
    }

    @Test func notificationText() throws {
        let alerts = demo.filter { $0.severity == .alert }
        let one = try #require(Formatting.notification(for: [alerts[0]]))
        #expect(one.title == "New nerf-watch alert")
        #expect(one.body == "Requested claude-opus-5 but claude-sonnet-5 answered (claude · claude-sonnet-5 · CLI 2.1.272)")
        let two = try #require(Formatting.notification(for: alerts))
        #expect(two.title == "2 new nerf-watch alerts")
        #expect(two.body.hasSuffix("and 1 more"))
        #expect(Formatting.notification(for: []) == nil)
    }
}
