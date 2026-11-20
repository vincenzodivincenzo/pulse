import AppKit
let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
let inset: CGFloat = 100
let r = NSRect(x: inset, y: inset, width: S - 2*inset, height: S - 2*inset)
NSColor(srgbRed: 0.086, green: 0.098, blue: 0.11, alpha: 1).setFill()
NSBezierPath(roundedRect: r, xRadius: 185, yRadius: 185).fill()
let cfg = NSImage.SymbolConfiguration(pointSize: 430, weight: .regular)
  .applying(.init(paletteColors: [NSColor(srgbRed: 0.95, green: 0.33, blue: 0.35, alpha: 1)]))
let sym = NSImage(systemSymbolName: "heart.fill", accessibilityDescription: nil)!.withSymbolConfiguration(cfg)!
let s = sym.size
sym.draw(in: NSRect(x: (S - s.width)/2, y: (S - s.height)/2 - 6, width: s.width, height: s.height))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
