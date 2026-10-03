import AppKit
import NerfWatchCore
import SwiftUI

/// The window that drops down from the menu bar icon.
struct MenuContentView: View {
    @ObservedObject var monitor: Monitor
    @State private var selected: Finding?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let finding = selected {
                FindingDetailView(finding: finding) { selected = nil }
            } else {
                header
                Divider().padding(.vertical, 6)
                findingsSection
                Divider().padding(.vertical, 6)
                actions
            }
        }
        .padding(.vertical, 10)
        .frame(width: 420)
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(nsImage: StatusIcon.menuBarImage(monitor.status, running: monitor.isRunning))
                .resizable()
                .frame(width: 26, height: 26)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(monitor.headline).font(.headline)
                    SeverityBadge(status: monitor.status)
                    if monitor.isRunning {
                        ProgressView().controlSize(.small).scaleEffect(0.7).frame(height: 12)
                    }
                }
                Text(timingLine).font(.caption).foregroundColor(.secondary)
                if let detail = monitor.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if monitor.needsNode {
                    Button("How to install Node.js") { NSWorkspace.shared.open(CLILocator.nodeInstallURL) }
                        .buttonStyle(.link)
                        .font(.caption)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .accessibilityElement(children: .combine)
    }

    private var timingLine: String {
        var parts: [String] = []
        if monitor.isRunning {
            parts.append("Checking now")
        } else if let last = monitor.lastChecked {
            parts.append("Checked \(last.formatted(date: .omitted, time: .shortened))")
        }
        if !monitor.isRunning, let next = monitor.nextCheck {
            parts.append("next at \(next.formatted(date: .omitted, time: .shortened))")
        }
        return parts.isEmpty ? "Runs nerf-watch check on this Mac" : parts.joined(separator: ", ")
    }

    // MARK: Findings

    @ViewBuilder
    private var findingsSection: some View {
        let findings = monitor.findings
        if findings.isEmpty {
            Text(emptyText)
                .font(.callout)
                .foregroundColor(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 4)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(findings) { f in
                        FindingRow(finding: f) { selected = f }
                    }
                }
            }
            .frame(maxHeight: min(CGFloat(findings.count) * 50 + 4, 340))
        }
    }

    private var emptyText: String {
        switch monitor.phase {
        case .result: return "No changes crossed a threshold."
        case .notRun: return monitor.isRunning ? "Reading session logs." : "Findings appear here after the first check."
        default: return "No findings to show."
        }
    }

    // MARK: Actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuRow(title: monitor.isRunning ? "Checking" : "Check now", shortcut: "R", disabled: monitor.isRunning) {
                Task { await monitor.checkNow() }
            }
            .keyboardShortcut("r")
            MenuRow(title: "Copy anonymized report", disabled: monitor.isBuildingReport) { monitor.copyReport() }
            if let message = monitor.reportMessage {
                Text(message)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            MenuRow(title: "Open nerf-watch on GitHub") { NSWorkspace.shared.open(AppSettings.repositoryURL) }
            Divider().padding(.vertical, 4)
            MenuRow(title: "Settings", shortcut: ",") { SettingsWindow.show(monitor: monitor) }
                .keyboardShortcut(",")
            MenuRow(title: "Quit Nerf Watch", shortcut: "Q") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
    }
}

/// One finding in the list: severity, title, agent, model, version range.
struct FindingRow: View {
    let finding: Finding
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 8) {
                SeverityBadge(severity: finding.severity)
                VStack(alignment: .leading, spacing: 2) {
                    Text(finding.title)
                        .font(.system(size: 12.5, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(Formatting.subtitle(finding))
                        .font(.caption)
                        .foregroundColor(hovering ? .white.opacity(0.85) : .secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(hovering ? .white : .secondary)
                    .accessibilityHidden(true)
            }
            .foregroundColor(hovering ? .white : .primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 5).fill(hovering ? Color.accentColor : Color.clear))
            .padding(.horizontal, 6)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("\(finding.title). Click for details.")
        .accessibilityLabel("\(finding.severity.label): \(finding.title). \(Formatting.subtitle(finding))")
        .accessibilityHint("Shows the evidence")
    }
}

/// A menu-like row with hover highlight.
struct MenuRow: View {
    let title: String
    var shortcut: String? = nil
    var disabled = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                if let shortcut {
                    Text("⌘\(shortcut)").foregroundColor(hovering && !disabled ? .white.opacity(0.85) : .secondary)
                }
            }
            .font(.system(size: 13))
            .foregroundColor(disabled ? .secondary : (hovering ? .white : .primary))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 5).fill(hovering && !disabled ? Color.accentColor : Color.clear))
            .padding(.horizontal, 6)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .onHover { hovering = $0 }
    }
}
