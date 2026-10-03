import AppKit
import NerfWatchCore
import SwiftUI

/// Menu bar and in-menu status symbols. Each status has its own shape as well as
/// its own color, so it reads without color vision and in a monochrome menu bar.
enum StatusIcon {
    static func symbolName(_ status: Status, running: Bool) -> String {
        switch status {
        case .ok: return "checkmark.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .alert: return "exclamationmark.octagon.fill"
        case .unknown: return running ? "ellipsis.circle" : "circle.dashed"
        }
    }

    static func color(_ status: Status) -> NSColor? {
        switch status {
        case .ok: return .systemGreen
        case .warn: return .systemYellow
        case .alert: return .systemRed
        case .unknown: return nil
        }
    }

    /// Image for the menu bar. Grey states are template images so they follow the
    /// menu bar's light or dark appearance; colored states use a dark glyph on yellow
    /// and a white glyph on green and red, which stay legible on both.
    static func menuBarImage(_ status: Status, running: Bool) -> NSImage {
        let name = symbolName(status, running: running)
        let description = "Nerf Watch: \(Formatting.statusWord(status))"
        let base = NSImage(systemSymbolName: name, accessibilityDescription: description) ?? NSImage()
        var config = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
        guard let fill = color(status) else {
            let img = base.withSymbolConfiguration(config) ?? base
            img.isTemplate = true
            return img
        }
        let glyph: NSColor = status == .warn ? .black : .white
        config = config.applying(NSImage.SymbolConfiguration(paletteColors: [glyph, fill]))
        let img = base.withSymbolConfiguration(config) ?? base
        img.isTemplate = false
        return img
    }
}

/// The menu bar label: status symbol, plus the number of alerts and warnings.
struct StatusLabel: View {
    @ObservedObject var monitor: Monitor
    @AppStorage(SettingsKey.showCountInMenuBar) private var showCount = true

    var body: some View {
        HStack(spacing: 3) {
            Image(nsImage: StatusIcon.menuBarImage(monitor.status, running: monitor.isRunning && monitor.status == .unknown))
            if showCount, monitor.attentionCount > 0 {
                Text("\(monitor.attentionCount)")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(monitor.statusDescription)
    }
}

/// Text badge used in the menu ("ALERT", "WARN", "INFO", "OK").
struct SeverityBadge: View {
    let text: String
    let color: Color
    let foreground: Color

    init(severity: Severity) {
        text = severity.label
        switch severity {
        case .alert: color = .red; foreground = .white
        case .warn: color = .yellow; foreground = .black
        case .info: color = .gray.opacity(0.35); foreground = .primary
        }
    }

    init(status: Status) {
        text = Formatting.statusWord(status).uppercased()
        switch status {
        case .alert: color = .red; foreground = .white
        case .warn: color = .yellow; foreground = .black
        case .ok: color = .green; foreground = .white
        case .unknown: color = .gray.opacity(0.35); foreground = .primary
        }
    }

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .foregroundColor(foreground)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .frame(minWidth: 40)
            .background(RoundedRectangle(cornerRadius: 4).fill(color))
            .fixedSize()
    }
}
