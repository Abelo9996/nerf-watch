import Foundation

/// What one run of `nerf-watch check --json` produced.
public enum CheckOutcome: Sendable, Equatable {
    /// The CLI ran and returned findings (possibly none).
    case result(CheckResult)
    /// The CLI ran but found no session logs.
    case noData(message: String)
    /// The CLI could not run or its output could not be read.
    case failure(CheckFailure)
}

public enum CheckFailure: Sendable, Equatable, Error {
    /// Neither `nerf-watch` nor `npx` could be found, or `node` is missing.
    case nodeMissing
    /// The CLI path set in Settings does not exist or is not executable.
    case cliNotFound(path: String)
    /// The CLI took longer than the timeout.
    case timedOut(seconds: Int)
    /// The CLI rejected the arguments (exit code 2), for example a bad log folder setting.
    case usage(message: String)
    /// Any other non-zero exit or unreadable output.
    case failed(message: String)

    /// One or two sentences suitable for the menu.
    public var message: String {
        switch self {
        case .nodeMissing:
            return "Node.js was not found. nerf-watch needs Node.js 20 or newer, or set the CLI path in Settings."
        case .cliNotFound(let path):
            return "The nerf-watch CLI set in Settings was not found or is not executable: \(path)"
        case .timedOut(let seconds):
            return "nerf-watch did not finish within \(seconds) seconds."
        case .usage(let message):
            return "nerf-watch rejected the options: \(message)"
        case .failed(let message):
            return message
        }
    }

    public var isNodeMissing: Bool { self == .nodeMissing }
}

public enum CheckParser {
    /// Exit codes from the CLI: 0 ok, 1 findings at or above `--fail-on`, 2 usage error.
    /// Anything else is a crash or a shell-level failure (127: command or interpreter not found).
    public static func parse(stdout: Data, stderr: Data, exitCode: Int32) -> CheckOutcome {
        let errText = String(decoding: stderr, as: UTF8.self)
        switch exitCode {
        case 0, 1:
            break
        case 2:
            return .failure(.usage(message: lastLine(errText) ?? "usage error"))
        case 127 where errText.contains("node"):
            // `#!/usr/bin/env node` failed: the CLI is installed but Node.js is not on PATH.
            return .failure(.nodeMissing)
        default:
            let detail = lastLine(errText).map { ": \($0)" } ?? ""
            return .failure(.failed(message: "nerf-watch exited with code \(exitCode)\(detail)"))
        }
        guard let json = extractJSONObject(stdout) else {
            let detail = lastLine(errText).map { " (\($0))" } ?? ""
            return .failure(.failed(message: "nerf-watch printed no JSON\(detail)."))
        }
        return parseJSON(json)
    }

    /// Decode the JSON document printed by `check --json`.
    public static func parseJSON(_ data: Data) -> CheckOutcome {
        struct Envelope: Decodable {
            var error: String?
            var message: String?
            var findings: [Finding]?
        }
        let envelope: Envelope
        do {
            envelope = try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            return .failure(.failed(message: "Could not read nerf-watch output: \(describe(error))"))
        }
        if let error = envelope.error {
            if error == "no-data" {
                return .noData(message: envelope.message ?? "No Claude Code or Codex session logs found.")
            }
            return .failure(.failed(message: envelope.message ?? error))
        }
        guard let findings = envelope.findings else {
            return .failure(.failed(message: "nerf-watch output had no findings list. Is the CLI up to date?"))
        }
        return .result(CheckResult(findings: findings))
    }

    /// Package managers can print notices before the JSON. Start at the first line that opens an object.
    static func extractJSONObject(_ data: Data) -> Data? {
        let text = String(decoding: data, as: UTF8.self)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("{") { return data }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) where line.hasPrefix("{") {
            return Data(text[line.startIndex...].utf8)
        }
        return nil
    }

    static func lastLine(_ text: String) -> String? {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty }
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case DecodingError.dataCorrupted(let ctx): return ctx.debugDescription
        case DecodingError.keyNotFound(let key, _): return "missing \(key.stringValue)"
        case DecodingError.typeMismatch(_, let ctx): return ctx.debugDescription
        default: return error.localizedDescription
        }
    }
}
