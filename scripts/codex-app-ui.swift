// Native macOS Accessibility helper for Antigravity-Codex Bridge.
// Subcommands:
//   probe
//   verify-and-submit <json-payload-on-stdin>
//
// Strictly uses official macOS Cocoa + ApplicationServices AXUIElement APIs.
// Never bypasses macOS Accessibility permissions; fails closed and preserves draft on any mismatch.
import Cocoa
import ApplicationServices
import Foundation

struct SubmitRequest: Decodable {
    let projectName: String
    let expectedModelLabel: String
    let expectedMessageId: String
    let expectedCallerId: String
    let timeoutMs: Int?
}

func emit(_ obj: [String: Any], exitCode: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func roleOf(_ el: AXUIElement) -> String { (attr(el, kAXRoleAttribute) as? String) ?? "" }
func titleOf(_ el: AXUIElement) -> String { (attr(el, kAXTitleAttribute) as? String) ?? "" }
func descOf(_ el: AXUIElement) -> String { (attr(el, kAXDescriptionAttribute) as? String) ?? "" }
func valueStringOf(_ el: AXUIElement) -> String { (attr(el, kAXValueAttribute) as? String) ?? "" }

func textOf(_ el: AXUIElement) -> String {
    [titleOf(el), descOf(el), valueStringOf(el)].filter { !$0.isEmpty }.joined(separator: " | ")
}

func findAll(_ el: AXUIElement, _ depth: Int = 0, _ pred: (AXUIElement) -> Bool) -> [AXUIElement] {
    if depth > 64 { return [] }
    var res: [AXUIElement] = []
    if pred(el) { res.append(el) }
    for c in childrenOf(el) {
        res.append(contentsOf: findAll(c, depth + 1, pred))
    }
    return res
}

func rectOf(_ el: AXUIElement) -> CGRect {
    var pt = CGPoint.zero
    var sz = CGSize.zero
    if let pv = attr(el, kAXPositionAttribute) { AXValueGetValue(pv as! AXValue, .cgPoint, &pt) }
    if let sv = attr(el, kAXSizeAttribute) { AXValueGetValue(sv as! AXValue, .cgSize, &sz) }
    return CGRect(origin: pt, size: sz)
}

func clickAt(_ pt: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.04)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func sendKey(_ code: CGKeyCode) {
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.03)
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
}

func findCodexApp() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.openai.codex" })
}

func checkAccessibility() -> Bool {
    AXIsProcessTrusted()
}

func runProbe() -> Never {
    let trusted = checkAccessibility()
    guard let app = findCodexApp() else {
        emit([
            "ok": false,
            "reason": "route_unavailable",
            "accessibility": trusted,
            "appRunning": false,
            "detail": "Codex App (com.openai.codex) is not running.",
        ])
    }
    if !trusted {
        emit([
            "ok": false,
            "reason": "access_denied",
            "accessibility": false,
            "appRunning": true,
            "detail": "macOS Accessibility permission is not granted for UI verification and submission.",
        ])
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let wins = attr(axApp, kAXWindowsAttribute) as? [AXUIElement], !wins.isEmpty else {
        emit([
            "ok": false,
            "reason": "route_unavailable",
            "accessibility": true,
            "appRunning": true,
            "windowCount": 0,
            "detail": "Codex App is running but has no accessible window open.",
        ])
    }
    emit([
        "ok": true,
        "accessibility": true,
        "appRunning": true,
        "windowCount": wins.count,
        "detail": "Codex App window and macOS Accessibility control are available.",
    ])
}

func runVerifyAndSubmit() -> Never {
    let rawInput = FileHandle.standardInput.readDataToEndOfFile()
    guard let req = try? JSONDecoder().decode(SubmitRequest.self, from: rawInput) else {
        emit(["ok": false, "reason": "invalid_argument", "draftPreserved": true, "detail": "Invalid JSON input."], exitCode: 2)
    }

    guard checkAccessibility() else {
        emit([
            "ok": false,
            "reason": "access_denied",
            "draftPreserved": true,
            "detail": "macOS Accessibility permission is not granted. Draft preserved in Codex App.",
        ], exitCode: 2)
    }

    guard let app = findCodexApp() else {
        emit([
            "ok": false,
            "reason": "route_unavailable",
            "draftPreserved": false,
            "detail": "Codex App (com.openai.codex) is not running.",
        ], exitCode: 2)
    }

    app.activate(options: [.activateIgnoringOtherApps])
    let activateDeadline = Date().addingTimeInterval(2.0)
    while !app.isActive && Date() < activateDeadline {
        Thread.sleep(forTimeInterval: 0.1)
    }
    Thread.sleep(forTimeInterval: 0.2)
    let deadline = Date().addingTimeInterval(Double(req.timeoutMs ?? 8000) / 1000.0)
    let axApp = AXUIElementCreateApplication(app.processIdentifier)

    func getWebArea() -> AXUIElement? {
        guard let wins = attr(axApp, kAXWindowsAttribute) as? [AXUIElement], let win = wins.first else { return nil }
        return findAll(win, 0, { roleOf($0) == "AXWebArea" }).first
    }

    func composerState(_ web: AXUIElement) -> (projectOk: Bool, locationOk: Bool, draftOk: Bool, ubText: String, draftPreview: String) {
        let ub = findAll(web, 0, { titleOf($0) == "Composer utility bar" }).first
        let ubText = ub.map { findAll($0, 0, { _ in true }).map(textOf).joined(separator: "\n") } ?? ""
        let locationOk = ubText.contains("This computer")
        let projectOk = ubText.contains("Change project: \(req.projectName)")
        let ta = findAll(web, 0, { roleOf($0) == "AXTextArea" }).first
        let draftVal = ta.map(valueStringOf) ?? ""
        let draftOk = draftVal.contains("message-id=\"\(req.expectedMessageId)\"") &&
            draftVal.contains("from-id=\"\(req.expectedCallerId)\"")
        return (projectOk, locationOk, draftOk, ubText, String(draftVal.prefix(160)))
    }

    // Wait up to timeout for the deep-link draft and project selection to settle in the composer.
    var web: AXUIElement? = nil
    var lastState = (projectOk: false, locationOk: false, draftOk: false, ubText: "", draftPreview: "")
    while Date() < deadline {
        if let w = getWebArea() {
            web = w
            lastState = composerState(w)
            if lastState.projectOk && lastState.locationOk && lastState.draftOk {
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.25)
    }

    guard let activeWeb = web else {
        emit(["ok": false, "reason": "route_unavailable", "draftPreserved": true, "detail": "Codex App composer WebArea is unavailable."], exitCode: 2)
    }
    guard lastState.locationOk && lastState.projectOk else {
        emit([
            "ok": false,
            "reason": "target_unavailable",
            "draftPreserved": true,
            "detail": "Could not verify project '\(req.projectName)' on 'This computer' in Codex App composer. Draft preserved.",
        ], exitCode: 2)
    }
    guard lastState.draftOk else {
        emit([
            "ok": false,
            "reason": "request_rejected",
            "draftPreserved": true,
            "detail": "Codex App composer text did not match expected dispatch ID and caller ID. Draft preserved.",
        ], exitCode: 2)
    }

    func findModelBtn() -> AXUIElement? {
        findAll(activeWeb, 0, {
            roleOf($0) == "AXPopUpButton" && titleOf($0).contains("GPT-")
        }).first
    }

    guard let modelBtn = findModelBtn() else {
        emit([
            "ok": false,
            "reason": "protocol_incompatible",
            "draftPreserved": true,
            "detail": "Could not locate model selector button in Codex App composer. Draft preserved.",
        ], exitCode: 2)
    }

    let initialModelLabel = titleOf(modelBtn)

    func findFastMenuItem() -> AXUIElement? {
        findAll(activeWeb, 0, {
            roleOf($0) == "AXMenuItem" && titleOf($0).lowercased().contains("fast mode")
        }).first
    }

    func openModelPopover() -> AXUIElement? {
        for _ in 0..<2 {
            app.activate(options: [.activateIgnoringOtherApps])
            Thread.sleep(forTimeInterval: 0.15)
            guard let mb = findModelBtn() else { return nil }
            let mr = rectOf(mb)
            clickAt(CGPoint(x: mr.midX, y: mr.midY))
            let popDeadline = Date().addingTimeInterval(1.6)
            while Date() < popDeadline {
                Thread.sleep(forTimeInterval: 0.15)
                if let item = findFastMenuItem() { return item }
            }
        }
        return nil
    }

    // Verify fast=false ("Enable fast mode"). If currently enabled ("Disable fast mode"), toggle off and re-verify.
    guard let fastItem = openModelPopover() else {
        sendKey(53)
        emit([
            "ok": false,
            "reason": "protocol_incompatible",
            "draftPreserved": true,
            "detail": "Could not verify Fast Mode state in Codex App model menu. Draft preserved.",
        ], exitCode: 2)
    }
    var fastTitle = titleOf(fastItem)
    if fastTitle == "Disable fast mode" {
        let fr = rectOf(fastItem)
        clickAt(CGPoint(x: fr.midX, y: fr.midY))
        Thread.sleep(forTimeInterval: 0.35)
        if findFastMenuItem() == nil {
            _ = openModelPopover()
        }
        fastTitle = findFastMenuItem().map(titleOf) ?? ""
    }
    guard fastTitle == "Enable fast mode" else {
        sendKey(53)
        emit([
            "ok": false,
            "reason": "protocol_incompatible",
            "draftPreserved": true,
            "detail": "Could not confirm standard speed (fast=false); menu shows '\(fastTitle)'. Draft preserved.",
        ], exitCode: 2)
    }

    // Adjust effort only when needed, stepping one notch at a time and checking the real button label after closing.
    func stepEffortOnce(directionRight: Bool) {
        if let pwr = findAll(activeWeb, 0, { roleOf($0) == "AXMenuItem" && titleOf($0) == "Power" }).first {
            AXUIElementSetAttributeValue(pwr, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            Thread.sleep(forTimeInterval: 0.15)
            sendKey(directionRight ? 124 : 123)
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    func directionTowardHigh(_ label: String) -> Bool? {
        if label == req.expectedModelLabel { return nil }
        if label.contains("Max") { return false } // step left
        if label.contains("Light") || label.contains("Medium") || label.contains("Extended") { return true } // step right
        return nil
    }

    if let dir = directionTowardHigh(initialModelLabel) {
        stepEffortOnce(directionRight: dir)
    }

    // Close model popover
    sendKey(53)
    Thread.sleep(forTimeInterval: 0.3)

    // If still not at target label (e.g. Light -> Medium -> High takes 2 steps), step cleanly until exact match (max 3 retries).
    var finalModelLabel = findModelBtn().map(titleOf) ?? ""
    for _ in 0..<3 {
        guard let dir = directionTowardHigh(finalModelLabel) else { break }
        if openModelPopover() == nil { break }
        stepEffortOnce(directionRight: dir)
        sendKey(53)
        Thread.sleep(forTimeInterval: 0.3)
        finalModelLabel = findModelBtn().map(titleOf) ?? ""
    }
    let finalState = composerState(activeWeb)
    guard finalModelLabel == req.expectedModelLabel else {
        emit([
            "ok": false,
            "reason": "protocol_incompatible",
            "draftPreserved": true,
            "detail": "Expected model/effort '\(req.expectedModelLabel)' but Codex App shows '\(finalModelLabel)'. Draft preserved.",
        ], exitCode: 2)
    }
    guard finalState.locationOk && finalState.projectOk && finalState.draftOk else {
        emit([
            "ok": false,
            "reason": "request_rejected",
            "draftPreserved": true,
            "detail": "Composer project or draft changed before send; submission aborted and draft preserved.",
        ], exitCode: 2)
    }

    guard let sendBtn = findAll(activeWeb, 0, {
        roleOf($0) == "AXButton" && (titleOf($0) == "Send" || descOf($0) == "Send")
    }).first else {
        emit([
            "ok": false,
            "reason": "protocol_incompatible",
            "draftPreserved": true,
            "detail": "Could not locate Send button in Codex App composer. Draft preserved.",
        ], exitCode: 2)
    }

    let sr = rectOf(sendBtn)
    clickAt(CGPoint(x: sr.midX, y: sr.midY))
    emit([
        "ok": true,
        "submitted": true,
        "verified": [
            "project": req.projectName,
            "location": "This computer",
            "modelLabel": finalModelLabel,
            "fast": false,
            "draft": true,
        ],
    ])
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "probe" {
    runProbe()
} else if args.count >= 2 && args[1] == "verify-and-submit" {
    runVerifyAndSubmit()
} else {
    emit(["ok": false, "reason": "invalid_argument", "detail": "Usage: codex-app-ui <probe|verify-and-submit>"], exitCode: 2)
}
