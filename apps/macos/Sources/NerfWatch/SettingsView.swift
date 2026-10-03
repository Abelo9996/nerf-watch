import AppKit
import NerfWatchCore
import SwiftUI

/// Settings window, hosted in a plain NSWindow so it opens reliably from a menu bar only app.
@MainActor
enum SettingsWindow {
    private static var window: NSWindow?

    static func show(monitor: Monitor) {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 420),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            w.title = "Nerf Watch Settings"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView(monitor: monitor))
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

struct SettingsView: View {
    @ObservedObject var monitor: Monitor
    @AppStorage(SettingsKey.intervalMinutes) private var interval = AppSettings.defaultInterval
    @AppStorage(SettingsKey.cliPath) private var cliPath = ""
    @AppStorage(SettingsKey.logFolders) private var logFolders = ""
    @AppStorage(SettingsKey.notifyOnNewAlerts) private var notify = true
    @AppStorage(SettingsKey.showCountInMenuBar) private var showCount = true
    @State private var launchAtLogin = LoginItem.isEnabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Section {
                Picker("Check", selection: $interval) {
                    ForEach(AppSettings.intervalChoices, id: \.self) { m in
                        Text(AppSettings.intervalLabel(m)).tag(m)
                    }
                }
                Toggle("Notify when a new alert appears", isOn: $notify)
                Toggle("Show the number of alerts and warnings in the menu bar", isOn: $showCount)
                Toggle("Launch at login", isOn: Binding(get: { launchAtLogin }, set: { setLaunchAtLogin($0) }))
                    .disabled(!LoginItem.isSupported)
                if !LoginItem.isSupported {
                    note("Available when running the bundled Nerf Watch.app.")
                } else if LoginItem.needsApproval {
                    HStack {
                        note("Allow Nerf Watch in System Settings > General > Login Items.")
                        Button("Open") { LoginItem.openSystemSettings() }
                    }
                }
                if let loginError { note(loginError) }
            }

            Section {
                HStack {
                    TextField("nerf-watch CLI", text: $cliPath, prompt: Text("Automatic"))
                        .disabled(AppSettings.cliPathFromEnvironment)
                    Button("Choose") { chooseCLI() }
                        .disabled(AppSettings.cliPathFromEnvironment)
                }
                note(cliNote)
                TextField("Log folders", text: $logFolders, prompt: Text("Default locations"), axis: .vertical)
                    .lineLimit(1...3)
                    .disabled(AppSettings.logFoldersFromEnvironment)
                note(AppSettings.logFoldersFromEnvironment
                     ? "Set by NERF_WATCH_ROOTS."
                     : "Optional. One agent=folder per line, passed as --root. Example: claude=~/work/.claude/projects")
            }

            Section {
                note("Nerf Watch only runs the nerf-watch CLI on this Mac and reads its output. The app makes no network requests. If the CLI is not installed it is started with npx, which downloads the package from npm.")
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .onChange(of: cliPath) { _ in monitor.resetCLIDiscovery() }
        .onAppear { launchAtLogin = LoginItem.isEnabled }
    }

    private var cliNote: String {
        if AppSettings.cliPathFromEnvironment { return "Set by NERF_WATCH_CLI." }
        var text = "Leave empty to use nerf-watch from your PATH, or npx -y nerf-watch@latest. A .js file is run with node."
        if let label = monitor.invocationLabel { text += "\nLast run: \(label)" }
        return text
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func setLaunchAtLogin(_ on: Bool) {
        do {
            try LoginItem.set(on)
            loginError = nil
        } catch {
            loginError = "Could not change the login item: \(error.localizedDescription)"
        }
        launchAtLogin = LoginItem.isEnabled
    }

    private func chooseCLI() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.message = "Choose the nerf-watch executable, or a cli.js file"
        if panel.runModal() == .OK, let url = panel.url {
            cliPath = url.path
        }
    }
}
