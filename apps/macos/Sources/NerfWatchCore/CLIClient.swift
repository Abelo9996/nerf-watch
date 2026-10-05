import Foundation

/// Runs `nerf-watch check --json` and `nerf-watch report --json` with the user's settings.
public struct CLIClient: Sendable {
    public var invocation: CLIInvocation
    /// `--root agent=dir` pairs from Settings or `NERF_WATCH_ROOTS`.
    public var rootArguments: [String]
    public var environment: [String: String]
    /// The first `npx` run downloads the package, so allow a generous timeout.
    public var timeout: TimeInterval

    public init(invocation: CLIInvocation, rootArguments: [String], environment: [String: String], timeout: TimeInterval = 180) {
        self.invocation = invocation
        self.rootArguments = rootArguments
        self.environment = environment
        self.timeout = timeout
    }

    public static let checkCommand = ["check", "--json"]
    public static let reportCommand = ["report", "--json"]

    public func check() async -> CheckOutcome {
        switch await run(Self.checkCommand) {
        case .failure(let f): return .failure(f)
        case .success(let out): return CheckParser.parse(stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode)
        }
    }

    /// The anonymized report as pretty printed JSON text.
    public func report() async -> Result<String, CheckFailure> {
        switch await run(Self.reportCommand) {
        case .failure(let f): return .failure(f)
        case .success(let out):
            guard out.exitCode == 0, let json = CheckParser.extractJSONObject(out.stdout),
                  let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
            else {
                let detail = CheckParser.lastLine(String(decoding: out.stderr, as: UTF8.self)) ?? "exit code \(out.exitCode)"
                return .failure(.failed(message: "Could not build the report: \(detail)"))
            }
            if let message = obj["message"] as? String, obj["error"] != nil {
                return .failure(.failed(message: message))
            }
            return .success(String(decoding: json, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// `nerf-watch card --out <file> --json`: writes the share card SVG to `outputPath`.
    public static func cardCommand(outputPath: String) -> [String] {
        ["card", "--out", outputPath, "--json"]
    }

    /// Where "Save share card" writes: the folder given (normally Downloads), named by date.
    public static func cardURL(directory: URL, date: Date) -> URL {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        let name = String(format: "nerf-watch-card-%04d-%02d-%02d.svg", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        return directory.appendingPathComponent(name)
    }

    /// Full argument list for a command, including the invocation prefix and the log folders.
    public func arguments(for command: [String]) -> [String] {
        invocation.arguments(command + rootArguments)
    }

    /// Writes the share card. Succeeds with the written path.
    public func card(outputPath: String) async -> Result<String, CheckFailure> {
        switch await run(Self.cardCommand(outputPath: outputPath)) {
        case .failure(let f): return .failure(f)
        case .success(let out): return Self.parseCard(stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode)
        }
    }

    /// Reads the `card --json` output: `{"out": path, ...}` when a card was written,
    /// `{"out": null, "message": ...}` when there was nothing to put on one.
    public static func parseCard(stdout: Data, stderr: Data, exitCode: Int32) -> Result<String, CheckFailure> {
        let errText = String(decoding: stderr, as: UTF8.self)
        if exitCode == 2 {
            let lines = errText.split(whereSeparator: \.isNewline).map(String.init)
            let first = lines.first { $0.hasPrefix("nerf-watch: ") }.map { String($0.dropFirst("nerf-watch: ".count)) }
            if let first, first.hasPrefix("Unknown command") {
                return .failure(.failed(message: "This nerf-watch is too old to make share cards. Update it (npm install -g nerf-watch) and try again."))
            }
            return .failure(.failed(message: first ?? CheckParser.lastLine(errText) ?? "nerf-watch rejected the options."))
        }
        guard exitCode == 0, let json = CheckParser.extractJSONObject(stdout),
              let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
        else {
            let detail = CheckParser.lastLine(errText) ?? "exit code \(exitCode)"
            return .failure(.failed(message: "Could not make the share card: \(detail)"))
        }
        if let path = obj["out"] as? String, !path.isEmpty { return .success(path) }
        return .failure(.failed(message: (obj["message"] as? String) ?? "No share card was written."))
    }

    private func run(_ command: [String]) async -> Result<ProcessOutput, CheckFailure> {
        do {
            let out = try await ProcessRunner.run(
                executable: invocation.executable,
                arguments: arguments(for: command),
                environment: environment,
                timeout: timeout
            )
            if out.timedOut { return .failure(.timedOut(seconds: Int(timeout))) }
            return .success(out)
        } catch {
            return .failure(.failed(message: "Could not start \(invocation.label): \(error.localizedDescription)"))
        }
    }

    /// Environment for the child: the user's environment with a complete PATH, no colors,
    /// and npm's update and funding notices turned off.
    public static func environment(base: [String: String], searchPath: [String]) -> [String: String] {
        var env = base
        env["PATH"] = searchPath.joined(separator: ":")
        env["NO_COLOR"] = "1"
        env["npm_config_update_notifier"] = "false"
        env["npm_config_fund"] = "false"
        env["npm_config_audit"] = "false"
        return env
    }

    /// PATH from the user's login shell, or nil if it cannot be read within a few seconds.
    public static func loginShellPath(environment: [String: String]) async -> String? {
        let shell = environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        guard let out = try? await ProcessRunner.run(
            executable: shell,
            arguments: ["-l", "-c", "printf %s \"$PATH\""],
            environment: environment,
            timeout: 5
        ), out.exitCode == 0, !out.timedOut else { return nil }
        // Profiles sometimes print a banner first; PATH is the last line.
        return CheckParser.lastLine(String(decoding: out.stdout, as: UTF8.self))
    }
}
