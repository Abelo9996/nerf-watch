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

    private func run(_ command: [String]) async -> Result<ProcessOutput, CheckFailure> {
        do {
            let out = try await ProcessRunner.run(
                executable: invocation.executable,
                arguments: invocation.arguments(command + rootArguments),
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
