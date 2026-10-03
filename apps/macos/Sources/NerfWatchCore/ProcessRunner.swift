import Foundation

public struct ProcessOutput: Sendable {
    public var exitCode: Int32
    public var stdout: Data
    public var stderr: Data
    public var timedOut: Bool
}

/// Runs a local process and collects its output. This is the only way the app
/// does anything: it never opens a network connection itself.
public enum ProcessRunner {
    public static func run(
        executable: String,
        arguments: [String],
        environment: [String: String],
        timeout: TimeInterval
    ) async throws -> ProcessOutput {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ProcessOutput, Error>) in
            DispatchQueue.global(qos: .utility).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                process.environment = environment
                process.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())
                let out = Pipe(), err = Pipe()
                process.standardOutput = out
                process.standardError = err
                process.standardInput = FileHandle.nullDevice

                let once = Once()
                let timedOut = Flag()
                do {
                    try process.run()
                } catch {
                    once.run { cont.resume(throwing: error) }
                    return
                }

                // Read both pipes concurrently so a full stderr buffer cannot block the child.
                let errData = DataBox()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global(qos: .utility).async {
                    errData.set(err.fileHandleForReading.readDataToEndOfFile())
                    group.leave()
                }

                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    guard process.isRunning else { return }
                    timedOut.set()
                    process.terminate()
                    // If a grandchild keeps the pipes open, give up waiting shortly after.
                    DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                        once.run { cont.resume(returning: ProcessOutput(exitCode: -1, stdout: Data(), stderr: Data(), timedOut: true)) }
                    }
                }

                let outData = out.fileHandleForReading.readDataToEndOfFile()
                group.wait()
                process.waitUntilExit()
                let result = ProcessOutput(
                    exitCode: process.terminationStatus,
                    stdout: outData,
                    stderr: errData.get(),
                    timedOut: timedOut.isSet
                )
                once.run { cont.resume(returning: result) }
            }
        }
    }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func run(_ body: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        body()
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
    func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
}
