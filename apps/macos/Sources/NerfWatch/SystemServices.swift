import AppKit
import ServiceManagement
import UserNotifications

/// Local notifications for new alerts. Only works when running as a bundled .app:
/// UserNotifications requires a bundle identifier.
final class Notifier: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    private var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }

    func prepare() {
        guard available else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func post(title: String, body: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // Show banners even if the app happens to be active.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}

/// Launch at login through SMAppService (macOS 13+).
enum LoginItem {
    static var isSupported: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    static var isEnabled: Bool {
        guard isSupported else { return false }
        switch SMAppService.mainApp.status {
        case .enabled, .requiresApproval: return true
        default: return false
        }
    }

    static var needsApproval: Bool { isSupported && SMAppService.mainApp.status == .requiresApproval }

    static func set(_ enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }

    static func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

/// MenuBarExtra does not expose its NSStatusItem. Its button lives in an
/// NSStatusBarWindow, which is enough to set a tooltip and, for demos, open the menu.
@MainActor
enum StatusItemAccess {
    private static func statusButton() -> NSButton? {
        for window in NSApp.windows where String(describing: type(of: window)).contains("StatusBarWindow") {
            if let button = findButton(in: window.contentView) { return button }
        }
        return nil
    }

    private static func findButton(in view: NSView?) -> NSButton? {
        guard let view else { return nil }
        if let b = view as? NSButton { return b }
        for sub in view.subviews {
            if let b = findButton(in: sub) { return b }
        }
        return nil
    }

    /// The view the status item draws in, for snapshots.
    static func statusItemView() -> NSView? {
        statusButton()?.window?.contentView
    }

    static func update(tooltip: String) {
        guard let button = statusButton() else { return }
        button.toolTip = tooltip
        button.setAccessibilityLabel(tooltip)
    }

    static func openMenu() {
        statusButton()?.performClick(nil)
    }
}
