import Foundation

/// How to start the nerf-watch CLI: an executable plus arguments that come before the command.
public struct CLIInvocation: Equatable, Sendable {
    public var executable: String
    public var prefixArguments: [String]
    /// Human readable form for Settings, for example "npx -y nerf-watch@latest".
    public var label: String

    public init(executable: String, prefixArguments: [String] = [], label: String) {
        self.executable = executable
        self.prefixArguments = prefixArguments
        self.label = label
    }

    public func arguments(_ command: [String]) -> [String] { prefixArguments + command }
}

/// Finds the CLI. Apps started from Finder get a minimal PATH (`/usr/bin:/bin:...`), so
/// the search also uses the login shell's PATH and the usual Node install locations.
public enum CLILocator {
    public static let packageSpec = "nerf-watch@latest"
    public static let nodeInstallURL = URL(string: "https://nodejs.org/en/download")!

    /// Resolve the invocation.
    /// - Parameters:
    ///   - customPath: path set in Settings (or `NERF_WATCH_CLI`). A `.js` file is run with `node`.
    ///   - searchPath: directories to search, in order.
    ///   - isExecutable: injected for tests.
    public static func resolve(
        customPath: String?,
        searchPath: [String],
        isExecutable: (String) -> Bool,
        fileExists: (String) -> Bool
    ) -> Result<CLIInvocation, CheckFailure> {
        func find(_ name: String) -> String? {
            searchPath.lazy.map { ($0 as NSString).appendingPathComponent(name) }.first(where: isExecutable)
        }

        if let raw = customPath?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
            let path = (raw as NSString).expandingTildeInPath
            let ext = (path as NSString).pathExtension.lowercased()
            if ["js", "mjs", "cjs"].contains(ext) {
                guard fileExists(path) else { return .failure(.cliNotFound(path: path)) }
                guard let node = find("node") else { return .failure(.nodeMissing) }
                return .success(CLIInvocation(executable: node, prefixArguments: [path], label: "node \(path)"))
            }
            guard isExecutable(path) else { return .failure(.cliNotFound(path: path)) }
            return .success(CLIInvocation(executable: path, label: path))
        }
        if let cli = find("nerf-watch") {
            return .success(CLIInvocation(executable: cli, label: "nerf-watch (\(cli))"))
        }
        if let npx = find("npx") {
            return .success(CLIInvocation(executable: npx, prefixArguments: ["-y", packageSpec], label: "npx -y \(packageSpec)"))
        }
        return .failure(.nodeMissing)
    }

    /// Directories to search for `nerf-watch`, `npx` and `node`, without duplicates.
    public static func searchPath(
        environmentPath: String?,
        loginShellPath: String?,
        home: String,
        listDirectory: (String) -> [String]
    ) -> [String] {
        var dirs: [String] = []
        func add(_ d: String) {
            let d = d.trimmingCharacters(in: .whitespaces)
            if !d.isEmpty, !dirs.contains(d) { dirs.append(d) }
        }
        for p in [loginShellPath, environmentPath] {
            for d in splitPath(p ?? "") { add(d) }
        }
        let h = home
        for d in [
            "/opt/homebrew/bin", "/usr/local/bin",
            "\(h)/.volta/bin", "\(h)/.local/bin", "\(h)/.npm-global/bin", "\(h)/.npm/bin",
            "\(h)/.asdf/shims", "\(h)/.local/share/mise/shims", "\(h)/Library/pnpm",
            "\(h)/.fnm/aliases/default/bin", "\(h)/.local/state/fnm_multishells",
        ] { add(d) }
        // nvm: newest installed version first.
        let nvm = "\(h)/.nvm/versions/node"
        for v in listDirectory(nvm).filter({ $0.hasPrefix("v") }).sorted(by: { compareVersions($0, $1) > 0 }) {
            add("\(nvm)/\(v)/bin")
        }
        for d in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] { add(d) }
        return dirs
    }

    /// `PATH` as printed by a login shell. fish prints a space separated list.
    static func splitPath(_ p: String) -> [String] {
        let trimmed = p.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains(":") { return trimmed.split(separator: ":").map(String.init) }
        return trimmed.split(separator: " ").map(String.init)
    }

    /// Compare "v22.1.0" style versions numerically.
    static func compareVersions(_ a: String, _ b: String) -> Int {
        func parts(_ s: String) -> [Int] {
            s.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").map { Int($0) ?? 0 }
        }
        let pa = parts(a), pb = parts(b)
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x < y ? -1 : 1 }
        }
        return 0
    }

    /// Turn the "Log folders" setting into `--root agent=dir` arguments.
    /// Entries are separated by newlines or commas; each is `agent=dir`.
    public static func rootArguments(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "\n" || $0 == "," })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { entry -> [String]? in
                guard let eq = entry.firstIndex(of: "="), eq != entry.startIndex else { return nil }
                let agent = entry[..<eq].trimmingCharacters(in: .whitespaces)
                let dir = entry[entry.index(after: eq)...].trimmingCharacters(in: .whitespaces)
                guard !dir.isEmpty else { return nil }
                return ["--root", "\(agent)=\((dir as NSString).expandingTildeInPath)"]
            }
            .flatMap { $0 }
    }
}
