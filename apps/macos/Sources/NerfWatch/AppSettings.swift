import Foundation

/// User settings, stored in UserDefaults. Environment variables override the CLI path
/// and log folders, which is how tests and demos point the app at synthetic logs:
///
///     NERF_WATCH_CLI=/path/to/nerf-watch/dist/cli.js
///     NERF_WATCH_ROOTS="claude=/tmp/nw-demo/claude/projects,codex=/tmp/nw-demo/codex/sessions"
enum SettingsKey {
    static let intervalMinutes = "intervalMinutes"
    static let cliPath = "cliPath"
    static let logFolders = "logFolders"
    static let notifyOnNewAlerts = "notifyOnNewAlerts"
    static let showCountInMenuBar = "showCountInMenuBar"
}

enum AppSettings {
    static let intervalChoices = [5, 15, 30, 60, 120, 240, 480, 1440]
    static let defaultInterval = 30

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            SettingsKey.intervalMinutes: defaultInterval,
            SettingsKey.cliPath: "",
            SettingsKey.logFolders: "",
            SettingsKey.notifyOnNewAlerts: true,
            SettingsKey.showCountInMenuBar: true,
        ])
    }

    static var environment: [String: String] { ProcessInfo.processInfo.environment }

    static var intervalMinutes: Int {
        let v = UserDefaults.standard.integer(forKey: SettingsKey.intervalMinutes)
        return v > 0 ? v : defaultInterval
    }

    /// CLI path from `NERF_WATCH_CLI`, else from Settings, else empty (auto detect).
    static var cliPath: String {
        if let env = environment["NERF_WATCH_CLI"], !env.isEmpty { return env }
        return UserDefaults.standard.string(forKey: SettingsKey.cliPath) ?? ""
    }

    static var cliPathFromEnvironment: Bool { !(environment["NERF_WATCH_CLI"] ?? "").isEmpty }

    /// Log folders from `NERF_WATCH_ROOTS`, else from Settings.
    static var logFolders: String {
        if let env = environment["NERF_WATCH_ROOTS"], !env.isEmpty { return env }
        return UserDefaults.standard.string(forKey: SettingsKey.logFolders) ?? ""
    }

    static var logFoldersFromEnvironment: Bool { !(environment["NERF_WATCH_ROOTS"] ?? "").isEmpty }

    static var notifyOnNewAlerts: Bool { UserDefaults.standard.bool(forKey: SettingsKey.notifyOnNewAlerts) }

    static func intervalLabel(_ minutes: Int) -> String {
        switch minutes {
        case 1440: return "Once a day"
        case 60: return "Every hour"
        case let m where m % 60 == 0: return "Every \(m / 60) hours"
        default: return "Every \(minutes) minutes"
        }
    }

    static let repositoryURL = URL(string: "https://github.com/Abelo9996/nerf-watch")!
    static let installURL = URL(string: "https://github.com/Abelo9996/nerf-watch#menu-bar-app-macos")!
}
