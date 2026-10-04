import AppKit
import Foundation
import NerfWatchCore

/// Runs the CLI on a schedule and on demand, and holds what the menu shows.
@MainActor
final class Monitor: ObservableObject {
    enum Phase: Equatable {
        case notRun
        case result(CheckResult)
        case noData(String)
        case failed(CheckFailure)
    }

    @Published private(set) var phase: Phase = .notRun
    @Published private(set) var isRunning = false
    @Published private(set) var lastChecked: Date?
    @Published private(set) var nextCheck: Date?
    @Published private(set) var invocationLabel: String?
    /// Transient feedback for "Copy anonymized report".
    @Published var reportMessage: String?
    @Published private(set) var isBuildingReport = false

    private let store = StateStore(directory: StateStore.defaultDirectory())
    private let notifier = Notifier()
    private var searchPath: [String]?
    private var scheduleTask: Task<Void, Never>?
    private var wakeObserver: NSObjectProtocol?
    private var defaultsObserver: NSObjectProtocol?
    private var scheduledInterval = AppSettings.intervalMinutes
    private var lastAttempt: Date?
    private var openedForDemo = false
    private var snapshotWritten = false

    init() {
        AppSettings.registerDefaults()
        notifier.prepare()
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.checkIfDue() }
        }
        defaultsObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.settingsChanged() }
        }
        Task { await self.checkNow() }
        reschedule()
    }

    // MARK: Status

    var status: Status {
        switch phase {
        case .result(let r): return Status(r)
        default: return .unknown
        }
    }

    var findings: [Finding] {
        if case .result(let r) = phase { return r.findings }
        return []
    }

    /// Alerts plus warnings, shown next to the icon.
    var attentionCount: Int {
        if case .result(let r) = phase { return r.counts.alert + r.counts.warn }
        return 0
    }

    var headline: String {
        switch phase {
        case .notRun: return isRunning ? "Checking session logs" : "Not checked yet"
        case .result(let r): return Formatting.summary(r.counts)
        case .noData: return "No session logs found"
        case .failed: return "Check failed"
        }
    }

    var detail: String? {
        switch phase {
        case .noData(let m): return m
        case .failed(let f): return f.message
        default: return nil
        }
    }

    var needsNode: Bool {
        if case .failed(let f) = phase { return f.isNodeMissing }
        return false
    }

    /// Status in words: never color alone.
    var statusWord: String {
        switch phase {
        case .notRun: return "Not checked"
        case .noData: return "No data"
        case .failed: return "Error"
        case .result: return Formatting.statusWord(status)
        }
    }

    /// Tooltip and accessibility text for the menu bar item.
    var statusDescription: String {
        var text = "Nerf Watch: \(statusWord). \(headline)."
        if let d = lastChecked {
            text += " Last checked \(d.formatted(date: .omitted, time: .shortened))."
        }
        if isRunning { text += " Checking now." }
        return text
    }

    // MARK: Running

    func checkNow() async {
        guard !isRunning else { return }
        isRunning = true
        lastAttempt = Date()
        defer {
            isRunning = false
            reschedule()
            StatusItemAccess.update(tooltip: statusDescription)
        }
        StatusItemAccess.update(tooltip: statusDescription)

        switch await makeClient() {
        case .failure(let f):
            // Node.js missing or a bad CLI path: shown in the menu with what to do.
            phase = .failed(f)
        case .success(let client):
            let outcome = await client.check()
            lastChecked = Date()
            switch outcome {
            case .result(let r):
                phase = .result(r)
                // Only successful runs move the baseline for "new" alerts.
                let fresh = store.record(r)
                if AppSettings.notifyOnNewAlerts, let n = Formatting.notification(for: fresh) {
                    notifier.post(title: n.title, body: n.body)
                }
            case .noData(let m):
                phase = .noData(m)
            case .failure(let f):
                phase = .failed(f)
            }
        }
        if !openedForDemo, ProcessInfo.processInfo.environment["NERF_WATCH_OPEN_MENU"] == "1" {
            // Demo and screenshot hook: open the menu once the first result is in.
            openedForDemo = true
            try? await Task.sleep(nanoseconds: 300_000_000)
            StatusItemAccess.openMenu()
        }
        if !snapshotWritten {
            snapshotWritten = true
            // After this check has finished, so the snapshot shows the settled state.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 800_000_000)
                Snapshot.writeIfRequested(monitor: self)
            }
        }
    }

    func copyReport() {
        guard !isBuildingReport else { return }
        isBuildingReport = true
        reportMessage = "Building report"
        Task {
            defer { isBuildingReport = false }
            let result: Result<String, CheckFailure>
            switch await makeClient() {
            case .failure(let f): result = .failure(f)
            case .success(let client): result = await client.report()
            }
            switch result {
            case .success(let json):
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(json, forType: .string)
                reportMessage = "Copied. Review it before sharing."
            case .failure(let f):
                reportMessage = f.message
            }
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !isBuildingReport { reportMessage = nil }
        }
    }

    private func makeClient() async -> Result<CLIClient, CheckFailure> {
        let env = ProcessInfo.processInfo.environment
        if searchPath == nil {
            let login = await CLIClient.loginShellPath(environment: env)
            searchPath = CLILocator.searchPath(
                environmentPath: env["PATH"],
                loginShellPath: login,
                home: NSHomeDirectory(),
                listDirectory: { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] }
            )
        }
        let path = searchPath ?? []
        let resolved = CLILocator.resolve(
            customPath: AppSettings.cliPath,
            searchPath: path,
            isExecutable: { p in
                var isDir: ObjCBool = false
                return FileManager.default.fileExists(atPath: p, isDirectory: &isDir) && !isDir.boolValue
                    && FileManager.default.isExecutableFile(atPath: p)
            },
            fileExists: { FileManager.default.fileExists(atPath: $0) }
        )
        switch resolved {
        case .failure(let f):
            invocationLabel = nil
            return .failure(f)
        case .success(let inv):
            invocationLabel = inv.label
            return .success(CLIClient(
                invocation: inv,
                rootArguments: CLILocator.rootArguments(AppSettings.logFolders),
                environment: CLIClient.environment(base: env, searchPath: path)
            ))
        }
    }

    // MARK: Scheduling

    private func reschedule() {
        scheduleTask?.cancel()
        let minutes = AppSettings.intervalMinutes
        scheduledInterval = minutes
        let seconds = Double(minutes) * 60
        let base = lastAttempt ?? Date()
        let next = max(base.addingTimeInterval(seconds), Date().addingTimeInterval(5))
        nextCheck = next
        scheduleTask = Task { [weak self] in
            let delay = next.timeIntervalSinceNow
            try? await Task.sleep(nanoseconds: UInt64(max(delay, 1) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.checkNow()
        }
    }

    /// After sleep, timers fire late; run at once if a check is overdue.
    private func checkIfDue() {
        guard let next = nextCheck, next <= Date(), !isRunning else { return }
        Task { await checkNow() }
    }

    private func settingsChanged() {
        if AppSettings.intervalMinutes != scheduledInterval, !isRunning { reschedule() }
    }

    /// Settings that change which CLI runs should take effect on the next check.
    func resetCLIDiscovery() {
        searchPath = nil
        invocationLabel = nil
    }
}
