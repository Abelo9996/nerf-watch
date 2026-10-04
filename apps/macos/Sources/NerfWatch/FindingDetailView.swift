import AppKit
import NerfWatchCore
import SwiftUI

/// Evidence for one finding: the numbers on each side of the comparison.
struct FindingDetailView: View {
    let finding: Finding
    let back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button(action: back) {
                    HStack(spacing: 3) {
                        Image(systemName: "chevron.left")
                        Text("Findings")
                    }
                }
                .buttonStyle(.borderless)
                .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Copy") { copy() }
                    .buttonStyle(.borderless)
                    .help("Copy this finding as text")
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SeverityBadge(severity: finding.severity)
                Text(finding.title)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
                meta("Agent", finding.agent)
                if let model = finding.model { meta("Model", model) }
                meta("Changed", Formatting.triggerText(finding))
                if !Formatting.versionRange(finding).isEmpty { meta("Versions", Formatting.versionRange(finding)) }
                if !Formatting.dateRange(finding).isEmpty { meta("Dates", Formatting.dateRange(finding)) }
                meta("Check", finding.detector)
            }
            .font(.caption)

            if !finding.evidence.isEmpty {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    GridRow {
                        Text("")
                        Text("Value")
                        Text("Based on")
                        Text("CLI")
                        Text("Dates")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
                    Divider().gridCellUnsizedAxes(.horizontal)
                    ForEach(Array(finding.evidence.enumerated()), id: \.offset) { _, e in
                        GridRow {
                            Text(e.label).foregroundColor(.secondary)
                            Text(e.display).font(.system(.caption, design: .monospaced).weight(.semibold))
                            Text(samples(e)).monospacedDigit()
                            Text((e.versions ?? []).joined(separator: ", ")).lineLimit(2)
                            Text(dates(e)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.caption)
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
                .textSelection(.enabled)
            }

            Text(finding.explanation)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if let next = finding.nextStep, !next.isEmpty {
                (Text("Next: ").bold() + Text(next))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 14)
    }

    private func meta(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundColor(.secondary)
            Text(value).textSelection(.enabled)
        }
    }

    private func samples(_ e: Evidence) -> String { Formatting.samples(e) }

    private func dates(_ e: Evidence) -> String {
        switch (e.from, e.to) {
        case let (f?, t?) where f == t: return f
        case let (f?, t?): return "\(f) to \(t)"
        case let (f?, nil): return f
        case let (nil, t?): return t
        default: return ""
        }
    }

    private func copy() {
        var lines = ["\(finding.severity.label)  \(finding.agent)  \(finding.model ?? "")  \(finding.title)"]
        for e in finding.evidence {
            lines.append("  \(e.label): \(e.display)  \(samples(e))  cli \((e.versions ?? []).joined(separator: ", "))  \(dates(e))")
        }
        lines.append(finding.explanation)
        if let next = finding.nextStep, !next.isEmpty { lines.append("Next: \(next)") }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }
}
