import AppKit
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("usage: screen observe | capture <state-root> <force|changed>") }

switch arguments[1] {
case "observe":
    let observer = Observer()
    observer.run()
case "capture":
    guard arguments.count == 4 else { fail("capture requires state root and mode") }
    let stateRoot = URL(fileURLWithPath: arguments[2], isDirectory: true)
    let forceCapture = arguments[3] == "force"
    Task { @MainActor in
        do {
            Output.json(try await capture(stateRoot: stateRoot, force: forceCapture))
            exit(0)
        } catch {
            fputs("screen capture: \(error)\n", stderr)
            exit(1)
        }
    }
    RunLoop.main.run()
default:
    fail("unknown command: \(arguments[1])")
}

final class Observer {
    private var inputPending = false
    private var lastContext = contextKey()
    private var monitors: [Any] = []

    func run() {
        let center = NSWorkspace.shared.notificationCenter
        monitors.append(center.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in self?.contextChanged() })
        monitors.append(center.addObserver(
            forName: NSWorkspace.screensDidSleepNotification,
            object: nil,
            queue: .main
        ) { _ in emit(kind: "sleep") })
        monitors.append(center.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { _ in emit(kind: "wake") })
        let distributed = DistributedNotificationCenter.default()
        monitors.append(distributed.addObserver(
            forName: NSNotification.Name("com.apple.screenIsLocked"),
            object: nil,
            queue: .main
        ) { _ in emit(kind: "sleep") })
        monitors.append(distributed.addObserver(
            forName: NSNotification.Name("com.apple.screenIsUnlocked"),
            object: nil,
            queue: .main
        ) { _ in emit(kind: "wake") })

        let mask: NSEvent.EventTypeMask = [.keyDown, .leftMouseUp, .rightMouseUp, .otherMouseUp, .scrollWheel]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            self?.inputObserved()
        }) {
            monitors.append(monitor)
        }

        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.contextChanged()
        }
        RunLoop.main.run()
    }

    private func inputObserved() {
        guard !inputPending else { return }
        inputPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.inputPending = false
            emit(kind: "input")
        }
    }

    private func contextChanged() {
        let current = contextKey()
        guard current != lastContext else { return }
        lastContext = current
        emit(kind: "context")
    }
}

func capture(stateRoot: URL, force: Bool) async throws -> [String: Any] {
    guard let frontmost = NSWorkspace.shared.frontmostApplication else {
        return ["type": "skip"]
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let window = frontWindow(for: frontmost.processIdentifier, in: content.windows) else {
        return ["type": "skip"]
    }

    let bundleId = frontmost.bundleIdentifier ?? ""
    let key = "\(bundleId):\(window.windowID)"
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let probe = try await screenshot(filter: filter, frame: window.frame, maxWidth: 320)
    let preview = grayscale(probe, width: 64, height: 64)
    if !force, !meaningfullyChanged(preview, contextKey: key, stateRoot: stateRoot) {
        return ["type": "skip"]
    }

    let image = try await screenshot(filter: filter, frame: window.frame, maxWidth: 1600)
    let cachedOCR = readJSON(stateRoot.appending(path: "cache/ocr.json"))
    let recognized = try recognizeText(image, contextKey: key, cached: cachedOCR)
    let incoming = stateRoot.appending(path: "incoming", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: incoming, withIntermediateDirectories: true)
    let id = UUID().uuidString.lowercased()
    let imageURL = incoming.appending(path: "\(id).jpg")
    let previewURL = incoming.appending(path: "\(id).preview")
    try writeJPEG(image, to: imageURL, quality: 0.75)
    try Data(preview).write(to: previewURL, options: .atomic)

    return [
        "type": "capture",
        "contextKey": key,
        "app": [
            "name": frontmost.localizedName ?? "Unknown",
            "bundleId": bundleId,
        ],
        "capturedAt": ISO8601DateFormatter.withFractionalSeconds.string(from: Date()),
        "image": imageURL.path,
        "preview": previewURL.path,
        "ocr": recognized.text,
        "ocrSignature": recognized.signature ?? NSNull(),
    ]
}

func screenshot(filter: SCContentFilter, frame: CGRect, maxWidth: Int) async throws -> CGImage {
    let width = min(maxWidth, max(1, Int(frame.width * 2)))
    let height = max(1, Int(Double(width) * frame.height / frame.width))
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
}

func frontWindow(for pid: pid_t, in windows: [SCWindow]) -> SCWindow? {
    let ids = (CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] ?? []).compactMap { value -> CGWindowID? in
        guard value[kCGWindowOwnerPID as String] as? pid_t == pid,
              value[kCGWindowLayer as String] as? Int == 0,
              let id = value[kCGWindowNumber as String] as? CGWindowID
        else { return nil }
        return id
    }
    for id in ids {
        if let window = windows.first(where: { $0.windowID == id && $0.frame.width >= 100 && $0.frame.height >= 100 }) {
            return window
        }
    }
    return windows.first {
        $0.owningApplication?.processID == pid && $0.frame.width >= 100 && $0.frame.height >= 100
    }
}

func contextKey() -> String {
    guard let app = NSWorkspace.shared.frontmostApplication else { return "" }
    let bundle = app.bundleIdentifier ?? ""
    let pid = app.processIdentifier
    let window = (CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] ?? []).first {
        $0[kCGWindowOwnerPID as String] as? pid_t == pid
            && $0[kCGWindowLayer as String] as? Int == 0
    }
    let id = window?[kCGWindowNumber as String] as? CGWindowID ?? 0
    return "\(bundle):\(id)"
}

func meaningfullyChanged(_ current: [UInt8], contextKey: String, stateRoot: URL) -> Bool {
    let metadata = readJSON(stateRoot.appending(path: "cache/preview.json"))
    guard metadata?["contextKey"] as? String == contextKey,
          let previous = try? Data(contentsOf: stateRoot.appending(path: "cache/preview.bin")),
          previous.count == current.count
    else { return true }

    var changed = 0
    for (left, right) in zip(previous, current) {
        if abs(Int(left) - Int(right)) > 12 { changed += 1 }
    }
    return Double(changed) / Double(current.count) > 0.05
}

func recognizeText(
    _ image: CGImage,
    contextKey: String,
    cached: [String: Any]?
) throws -> (text: String, signature: String?) {
    let detection = VNDetectTextRectanglesRequest()
    detection.reportCharacterBoxes = false
    try VNImageRequestHandler(cgImage: image).perform([detection])
    guard let observations = detection.results, !observations.isEmpty,
          let crop = textCrop(observations, in: image)
    else { return ("", nil) }

    let signature = SHA256.hash(data: Data(grayscale(crop, width: 128, height: 128)))
        .map { String(format: "%02x", $0) }
        .joined()
    if cached?["contextKey"] as? String == contextKey,
       cached?["signature"] as? String == signature,
       let text = cached?["text"] as? String {
        return (text, signature)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    let supported = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = ["zh-Hans", "en-US"].filter(supported.contains)
    try VNImageRequestHandler(cgImage: crop).perform([request])
    let lines = (request.results ?? []).sorted {
        abs($0.boundingBox.maxY - $1.boundingBox.maxY) > 0.02
            ? $0.boundingBox.maxY > $1.boundingBox.maxY
            : $0.boundingBox.minX < $1.boundingBox.minX
    }.compactMap { $0.topCandidates(1).first?.string }
    return (lines.joined(separator: "\n"), signature)
}

func textCrop(_ observations: [VNTextObservation], in image: CGImage) -> CGImage? {
    let bounds = observations.dropFirst().reduce(observations[0].boundingBox) { $0.union($1.boundingBox) }
        .insetBy(dx: -0.01, dy: -0.01)
        .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
    let width = CGFloat(image.width)
    let height = CGFloat(image.height)
    let pixels = CGRect(
        x: bounds.minX * width,
        y: (1 - bounds.maxY) * height,
        width: bounds.width * width,
        height: bounds.height * height
    ).integral.intersection(CGRect(x: 0, y: 0, width: width, height: height))
    return pixels.isEmpty ? nil : image.cropping(to: pixels)
}

func grayscale(_ image: CGImage, width: Int, height: Int) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: width * height)
    bytes.withUnsafeMutableBytes { raw in
        guard let context = CGContext(
            data: raw.baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return bytes
}

func writeJPEG(_ image: CGImage, to url: URL, quality: Double) throws {
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.jpeg.identifier as CFString,
        1,
        nil
    ) else { throw ScreenError.jpeg }
    CGImageDestinationAddImage(
        destination,
        image,
        [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
    )
    guard CGImageDestinationFinalize(destination) else { throw ScreenError.jpeg }
}

func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

func emit(kind: String) {
    Output.json(["kind": kind])
}

enum Output {
    static func json(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let line = String(data: data, encoding: .utf8)
        else { return }
        print(line)
        fflush(stdout)
    }
}

func fail(_ message: String) -> Never {
    fputs("\(message)\n", stderr)
    exit(1)
}

enum ScreenError: Error {
    case jpeg
}

extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
