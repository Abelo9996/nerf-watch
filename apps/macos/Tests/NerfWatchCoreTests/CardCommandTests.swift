import Foundation
import Testing
@testable import NerfWatchCore

@Suite struct CardCommandTests {
    @Test func buildsTheCardCommand() {
        let client = CLIClient(
            invocation: CLIInvocation(executable: "/b/bin/npx", prefixArguments: ["-y", "nerf-watch@latest"], label: "npx -y nerf-watch@latest"),
            rootArguments: ["--root", "claude=/tmp/a/claude/projects"],
            environment: [:]
        )
        let out = "/Users/demo/Downloads/nerf-watch-card-2026-10-05.svg"
        #expect(CLIClient.cardCommand(outputPath: out) == ["card", "--out", out, "--json"])
        #expect(client.arguments(for: CLIClient.cardCommand(outputPath: out)) == [
            "-y", "nerf-watch@latest", "card", "--out", out, "--json", "--root", "claude=/tmp/a/claude/projects",
        ])
    }

    @Test func installedCLIHasNoPrefix() {
        let client = CLIClient(invocation: CLIInvocation(executable: "/opt/homebrew/bin/nerf-watch", label: "nerf-watch"), rootArguments: [], environment: [:])
        #expect(client.arguments(for: CLIClient.cardCommand(outputPath: "/tmp/c.svg")) == ["card", "--out", "/tmp/c.svg", "--json"])
    }

    @Test func namesTheFileByDate() {
        var c = DateComponents()
        c.year = 2026; c.month = 10; c.day = 5; c.hour = 12
        let date = Calendar.current.date(from: c)!
        let url = CLIClient.cardURL(directory: URL(fileURLWithPath: "/Users/demo/Downloads"), date: date)
        #expect(url.path == "/Users/demo/Downloads/nerf-watch-card-2026-10-05.svg")
    }

    @Test func parsesTheResult() {
        let ok = Data(#"{"out": "/tmp/c.svg", "kind": "clear", "headline": "No silent changes", "findings": 0, "more": 0}"#.utf8)
        #expect(CLIClient.parseCard(stdout: ok, stderr: Data(), exitCode: 0) == .success("/tmp/c.svg"))

        let none = Data(#"{"out":null,"message":"No card yet: there is not enough history to compare."}"#.utf8)
        #expect(CLIClient.parseCard(stdout: none, stderr: Data(), exitCode: 0) == .failure(.failed(message: "No card yet: there is not enough history to compare.")))

        let noData = Data(#"{"error":"no-data","message":"No Claude Code or Codex session logs found."}"#.utf8)
        #expect(CLIClient.parseCard(stdout: noData, stderr: Data(), exitCode: 0) == .failure(.failed(message: "No Claude Code or Codex session logs found.")))

        let old = Data("nerf-watch: Unknown command \"card\". Try: nerf-watch --help\n".utf8)
        guard case .failure(.failed(let message)) = CLIClient.parseCard(stdout: Data(), stderr: old, exitCode: 2) else {
            Issue.record("expected a failure")
            return
        }
        #expect(message.contains("too old"))

        #expect(CLIClient.parseCard(stdout: Data(), stderr: Data("boom\n".utf8), exitCode: 3) == .failure(.failed(message: "Could not make the share card: boom")))
    }

    @Test func runsTheCLIWithTheCardArguments() async throws {
        // A stand-in CLI that answers like `nerf-watch card --json`, echoing the path it was given.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nw-card-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let cli = dir.appendingPathComponent("nerf-watch")
        let body = #"[ "$1 $2 $4 $5" = "card --out --json --root" ] || exit 9; printf '{"out":"%s","kind":"findings"}' "$3""#
        try Data("#!/bin/sh\n\(body)\n".utf8).write(to: cli)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)
        let client = CLIClient(
            invocation: CLIInvocation(executable: cli.path, label: cli.path),
            rootArguments: ["--root", "claude=/tmp/demo"],
            environment: ["PATH": "/usr/bin:/bin"],
            timeout: 20
        )
        let target = dir.appendingPathComponent("nerf-watch-card-2026-10-05.svg").path
        #expect(await client.card(outputPath: target) == .success(target))
    }
}
