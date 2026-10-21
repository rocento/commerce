// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "RocentoAppBuilder", platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "RocentoAppBuilder", targets: ["RocentoAppBuilder"])],
    dependencies: [.package(path: "../RocentoCore")],
    targets: [
        .target(name: "RocentoAppBuilder", dependencies: [.product(name: "RocentoCore", package: "RocentoCore")], swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
        .testTarget(name: "RocentoAppBuilderTests", dependencies: ["RocentoAppBuilder", .product(name: "RocentoCore", package: "RocentoCore")]),
    ])
