// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NerfWatch",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "NerfWatch", targets: ["NerfWatch"]),
    ],
    targets: [
        // Pure logic: JSON parsing, alert diffing, CLI discovery, process runner, state file.
        // No AppKit or SwiftUI, so it is unit testable from the command line.
        .target(name: "NerfWatchCore"),
        // The menu bar app itself.
        .executableTarget(name: "NerfWatch", dependencies: ["NerfWatchCore"]),
        .testTarget(name: "NerfWatchCoreTests", dependencies: ["NerfWatchCore"]),
    ]
)
