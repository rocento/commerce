import ImageIO
import RocentoCore
import UIKit

/// Decoded images have a byte budget and expire; HTTP cache validation stays in URLSession.
actor MerchantImagePipeline {
  static let shared = MerchantImagePipeline()
  private final class Cached: NSObject {
    let image: UIImage
    let expires = Date().addingTimeInterval(300)
    init(_ image: UIImage) { self.image = image }
  }
  private let cache = NSCache<NSString, Cached>()
  init() { cache.totalCostLimit = 32 * 1024 * 1024; cache.countLimit = 128 }

  func image(_ url: URL, pixels: Int = 480) async throws -> UIImage {
    let key = "\(url.absoluteString)|\(pixels)" as NSString
    if let value = cache.object(forKey: key), value.expires > Date() { return value.image }
    let data = try await ImageDataLoader.shared.load(url)
    try Task.checkCancellation()
    // Another cell may have finished decoding while this request was in flight.
    if let value = cache.object(forKey: key), value.expires > Date() { return value.image }
    let image = try await Self.decode(data, pixels: pixels)
    try Task.checkCancellation()
    if let cg = image.cgImage { cache.setObject(Cached(image), forKey: key, cost: cg.bytesPerRow * cg.height) }
    return image
  }

  nonisolated static func decode(_ data: Data, pixels: Int) async throws -> UIImage {
    let task = Task.detached(priority: .utility) {
      try Task.checkCancellation()
      guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
        let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceThumbnailMaxPixelSize: max(1, min(pixels, 2048)),
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary) else { throw MobileFailure.invalidResponse }
      try Task.checkCancellation()
      return UIImage(cgImage: thumbnail)
    }
    return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
  }
}
