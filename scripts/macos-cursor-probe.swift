// Test-only probe: move the real macOS pointer and inspect the actual system cursor.
// Browser screenshots and computed CSS do not reveal a stale native cursor.
import AppKit
import CoreGraphics

let coordinates = CommandLine.arguments.dropFirst().map { Double($0)! }
precondition(coordinates.count % 2 == 0)
for index in stride(from: 0, to: coordinates.count, by: 2) {
    let x = coordinates[index], y = coordinates[index + 1]
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
            mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: index + 2 == coordinates.count ? 0.2 : 0.005)
}
var opaquePixels = 0
if let image = NSCursor.currentSystem?.image, let data = image.tiffRepresentation,
   let bitmap = NSBitmapImageRep(data: data) {
    for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide {
            if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0 { opaquePixels += 1 }
        }
    }
}
let point = CGEvent(source: nil)!.location
let result: [String: Any] = ["x": point.x, "y": point.y, "opaquePixels": opaquePixels]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
