// render-icon.swift OUT.png: draws the app icon, the monad symbol (a ring
// around a point), 1024x1024, opaque. Run: swift scripts/render-icon.swift <out>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = URL(fileURLWithPath: CommandLine.arguments[1])
let space = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(1) }
let s = CGFloat(size)
// Background: a deep blue-black vertical gradient.
let gradient = CGGradient(colorsSpace: space, colors: [
    CGColor(srgbRed: 0.09, green: 0.11, blue: 0.17, alpha: 1),
    CGColor(srgbRed: 0.03, green: 0.04, blue: 0.07, alpha: 1),
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: s), end: CGPoint(x: 0, y: 0), options: [])
let center = CGPoint(x: s / 2, y: s / 2)
let ink = CGColor(srgbRed: 0.93, green: 0.95, blue: 1.0, alpha: 1)
// The ring.
ctx.setStrokeColor(ink)
ctx.setLineWidth(s * 0.07)
let ringRadius = s * 0.30
ctx.strokeEllipse(in: CGRect(x: center.x - ringRadius, y: center.y - ringRadius, width: ringRadius * 2, height: ringRadius * 2))
// The point.
let dotRadius = s * 0.075
ctx.setFillColor(CGColor(srgbRed: 0.45, green: 0.72, blue: 1.0, alpha: 1))
ctx.fillEllipse(in: CGRect(x: center.x - dotRadius, y: center.y - dotRadius, width: dotRadius * 2, height: dotRadius * 2))
guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, image, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
