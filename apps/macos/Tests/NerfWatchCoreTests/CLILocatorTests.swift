import Foundation
import Testing
@testable import NerfWatchCore

@Suite struct CLILocatorTests {
    private func resolve(custom: String? = nil, path: [String] = ["/a/bin", "/b/bin"], executables: Set<String>, files: Set<String> = []) -> Result<CLIInvocation, CheckFailure> {
        CLILocator.resolve(customPath: custom, searchPath: path, isExecutable: { executables.contains($0) }, fileExists: { files.contains($0) || executables.contains($0) })
    }

    @Test func prefersInstalledCLI() throws {
        let r = resolve(executables: ["/b/bin/nerf-watch", "/a/bin/npx"])
        #expect(try r.get().executable == "/b/bin/nerf-watch")
        #expect(try r.get().arguments(["check", "--json"]) == ["check", "--json"])
    }

    @Test func fallsBackToNpx() throws {
        let inv = try resolve(executables: ["/b/bin/npx", "/b/bin/node"]).get()
        #expect(inv.executable == "/b/bin/npx")
        #expect(inv.arguments(["check", "--json"]) == ["-y", "nerf-watch@latest", "check", "--json"])
        #expect(inv.label == "npx -y nerf-watch@latest")
    }

    @Test func missingNodeIsReported() {
        #expect(resolve(executables: []) == .failure(.nodeMissing))
    }

    @Test func customExecutable() throws {
        #expect(try resolve(custom: "/opt/nw/nerf-watch", executables: ["/opt/nw/nerf-watch"]).get().executable == "/opt/nw/nerf-watch")
        #expect(resolve(custom: "/nope/nerf-watch", executables: ["/a/bin/nerf-watch"]) == .failure(.cliNotFound(path: "/nope/nerf-watch")))
    }

    @Test func customJavaScriptRunsWithNode() throws {
        let inv = try resolve(custom: "/src/nerf-watch/dist/cli.js", executables: ["/a/bin/node"], files: ["/src/nerf-watch/dist/cli.js"]).get()
        #expect(inv.executable == "/a/bin/node")
        #expect(inv.arguments(["check"]) == ["/src/nerf-watch/dist/cli.js", "check"])
        #expect(resolve(custom: "/src/cli.js", executables: [], files: ["/src/cli.js"]) == .failure(.nodeMissing))
        #expect(resolve(custom: "/src/missing.js", executables: ["/a/bin/node"]) == .failure(.cliNotFound(path: "/src/missing.js")))
    }

    @Test func blankCustomPathMeansAutomatic() throws {
        #expect(try resolve(custom: "  ", executables: ["/a/bin/nerf-watch"]).get().executable == "/a/bin/nerf-watch")
    }

    @Test func searchPathOrderAndNvm() {
        let dirs = CLILocator.searchPath(
            environmentPath: "/usr/bin:/bin",
            loginShellPath: "/custom/bin:/usr/bin",
            home: "/Users/demo",
            listDirectory: { $0 == "/Users/demo/.nvm/versions/node" ? ["v18.20.0", "v22.11.0", "v20.9.0", ".DS_Store"] : [] }
        )
        #expect(dirs.first == "/custom/bin")
        #expect(dirs.contains("/opt/homebrew/bin"))
        #expect(Set(dirs).count == dirs.count)
        let nvm = dirs.filter { $0.contains(".nvm") }
        #expect(nvm == [
            "/Users/demo/.nvm/versions/node/v22.11.0/bin",
            "/Users/demo/.nvm/versions/node/v20.9.0/bin",
            "/Users/demo/.nvm/versions/node/v18.20.0/bin",
        ])
    }

    @Test func fishPathIsSpaceSeparated() {
        #expect(CLILocator.splitPath("/opt/homebrew/bin /usr/bin\n") == ["/opt/homebrew/bin", "/usr/bin"])
    }

    @Test func rootArguments() {
        let args = CLILocator.rootArguments("claude=/tmp/a/claude/projects, codex = /tmp/a/codex/sessions\n\nbogus\n=nope\nx=")
        #expect(args == ["--root", "claude=/tmp/a/claude/projects", "--root", "codex=/tmp/a/codex/sessions"])
        #expect(CLILocator.rootArguments("") == [])
        let tilde = CLILocator.rootArguments("claude=~/logs")
        #expect(tilde[1].hasPrefix("claude=/"))
        #expect(!tilde[1].contains("~"))
    }

    @Test func environmentForChild() {
        let env = CLIClient.environment(base: ["HOME": "/Users/demo", "PATH": "/usr/bin"], searchPath: ["/opt/homebrew/bin", "/usr/bin"])
        #expect(env["PATH"] == "/opt/homebrew/bin:/usr/bin")
        #expect(env["NO_COLOR"] == "1")
        #expect(env["HOME"] == "/Users/demo")
    }
}

/// Runs a fake CLI script end to end through the real process runner.
@Suite struct CLIClientTests {
    private func script(_ body: String) throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nw-cli-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("nerf-watch")
        try Data("#!/bin/sh\n\(body)\n".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url.path
    }

    private func client(_ path: String, roots: String = "", timeout: TimeInterval = 20) -> CLIClient {
        CLIClient(
            invocation: CLIInvocation(executable: path, label: path),
            rootArguments: CLILocator.rootArguments(roots),
            environment: ["PATH": "/usr/bin:/bin"],
            timeout: timeout
        )
    }

    @Test func checkPassesArgumentsAndParsesExitCodeOne() async throws {
        // Echo the arguments into the title so the test can see them.
        let path = try script(#"""
        printf '{"summary":{"alert":1,"warn":0,"info":0},"findings":[{"id":"x","severity":"alert","agent":"claude","title":"%s","explanation":"","evidence":[],"trigger":"event"}]}' "$*"
        exit 1
        """#)
        let outcome = await client(path, roots: "claude=/tmp/demo").check()
        guard case .result(let r) = outcome else { Issue.record("got \(outcome)"); return }
        #expect(r.findings.first?.title == "check --json --root claude=/tmp/demo")
    }

    @Test func largeOutputDoesNotDeadlock() async throws {
        let path = try script(#"""
        i=0; while [ $i -lt 3000 ]; do echo "warning line $i padding padding padding padding" >&2; i=$((i+1)); done
        echo '{"findings":[]}'
        """#)
        let outcome = await client(path).check()
        guard case .result(let r) = outcome else { Issue.record("got \(outcome)"); return }
        #expect(r.findings.isEmpty)
    }

    @Test func timeoutIsReported() async throws {
        let path = try script("sleep 30")
        let outcome = await client(path, timeout: 1).check()
        #expect(outcome == .failure(.timedOut(seconds: 1)))
    }

    @Test func reportReturnsJSON() async throws {
        let path = try script(#"echo '{"tool":"nerf-watch","findings":[]}'"#)
        let report = try await client(path).report().get()
        #expect(report == #"{"tool":"nerf-watch","findings":[]}"#)
    }

    @Test func reportNoData() async throws {
        let path = try script(#"echo '{"error":"no-data","message":"No logs."}'"#)
        let report = await client(path).report()
        #expect(report == .failure(.failed(message: "No logs.")))
    }

    @Test func missingExecutableFailsCleanly() async {
        let outcome = await client("/definitely/not/here/nerf-watch").check()
        guard case .failure(.failed(let m)) = outcome else { Issue.record("got \(outcome)"); return }
        #expect(m.contains("Could not start"))
    }
}
