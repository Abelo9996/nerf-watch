import AppKit
import NerfWatchCore
import SwiftUI

/// Renders the menu to PNG files for the README, without screen recording permission.
/// Used only when `NERF_WATCH_SNAPSHOT=<dir>` is set, normally together with
/// `NERF_WATCH_ROOTS` pointing at synthetic logs from scripts/make-demo-data.mjs.
@MainActor
enum Snapshot {
    static func writeIfRequested(monitor: Monitor) {
        guard let dir = ProcessInfo.processInfo.environment["NERF_WATCH_SNAPSHOT"], !dir.isEmpty else { return }
        let url = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            render(SnapshotScene(monitor: monitor), appearance: appearance, to: url.appendingPathComponent("menubar-\(name).png"))
        }
        // What the real status item draws, to check the icon in the actual menu bar.
        if let view = StatusItemAccess.statusItemView() {
            write(view, to: url.appendingPathComponent("statusitem.png"))
        }
        // The real drop-down window, if it is open (NERF_WATCH_OPEN_MENU=1).
        for window in NSApp.windows where window.isVisible && !String(describing: type(of: window)).contains("StatusBarWindow") {
            if let view = window.contentView { write(view, to: url.appendingPathComponent("menu-window.png")) }
        }
    }

    private static func render<V: View>(_ view: V, appearance: NSAppearance.Name, to file: URL) {
        let host = NSHostingView(rootView: view)
        host.appearance = NSAppearance(named: appearance)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
        window.orderFrontRegardless()
        host.layoutSubtreeIfNeeded()
        host.display()
        write(host, to: file)
        window.orderOut(nil)
    }

    private static func write(_ view: NSView, to file: URL) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }
}

/// A menu bar strip with the status item, the open menu, and one finding's details.
private struct SnapshotScene: View {
    @ObservedObject var monitor: Monitor

    var body: some View {
        let detail = monitor.findings.first { $0.detector.hasPrefix("cacheCreation") } ?? monitor.findings.first
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                Spacer().frame(width: 300)
                StatusLabel(monitor: monitor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.14)))
                Spacer()
            }
            .frame(height: 26)
            .frame(maxWidth: .infinity)
            .background(Color(nsColor: .windowBackgroundColor).opacity(0.92))

            HStack(alignment: .top, spacing: 18) {
                panel { MenuContentView(monitor: monitor) }
                    .padding(.leading, 150)
                if let detail {
                    panel {
                        FindingDetailView(finding: detail) {}
                            .padding(.vertical, 12)
                            .frame(width: 420)
                    }
                }
            }
            .padding(.bottom, 28)
            .padding(.trailing, 28)
        }
        .background(
            LinearGradient(colors: [Color(red: 0.36, green: 0.45, blue: 0.62), Color(red: 0.55, green: 0.42, blue: 0.58)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .fixedSize()
    }

    private func panel<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content()
            .background(Color(nsColor: .windowBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.15), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.3), radius: 12, y: 4)
    }
}
