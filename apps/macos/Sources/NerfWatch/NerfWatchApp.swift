import AppKit
import SwiftUI

@main
struct NerfWatchApp: App {
    @StateObject private var monitor: Monitor

    init() {
        // Menu bar only: no Dock icon, even when run outside the .app bundle.
        NSApplication.shared.setActivationPolicy(.accessory)
        _monitor = StateObject(wrappedValue: Monitor())
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(monitor: monitor)
        } label: {
            StatusLabel(monitor: monitor)
        }
        .menuBarExtraStyle(.window)
    }
}
