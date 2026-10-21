import MapKit
import RocentoCore
import SwiftUI

struct MerchantImage: View {
  let url: URL?
  @State private var image: UIImage?
  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Image(systemName: "photo").resizable().scaledToFit().padding(30).foregroundStyle(.secondary)
      }
    }
    .accessibilityHidden(true).task(id: url) {
      image = nil
      guard let url else { return }
      do {
        let loaded = try await MerchantImagePipeline.shared.image(url)
        try Task.checkCancellation()
        image = loaded
      } catch {}
    }
  }
}

