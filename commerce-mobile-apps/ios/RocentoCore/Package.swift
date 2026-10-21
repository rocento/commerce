// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "RocentoCore", platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "RocentoCore", targets: ["RocentoCore"])],
    targets: [
        .target(name: "RocentoCore", resources: [.process("Resources")], swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
        .testTarget(name: "RocentoCoreTests", dependencies: ["RocentoCore"], resources: [.process("Resources")]),
    ])
