// swift-tools-version: 6.0

import PackageDescription

let kioskProducts: [Target.Dependency] = [
    .product(name: "KioskCore", package: "RNTxnContainer"),
    .product(name: "KioskAuth", package: "RNTxnContainer"),
    .product(name: "KioskTimeclock", package: "RNTxnContainer"),
    .product(name: "KioskNetworking", package: "RNTxnContainer"),
    .product(name: "KioskLifecycle", package: "RNTxnContainer"),
    .product(name: "KioskVerification", package: "RNTxnContainer"),
]

let package = Package(
    name: "KioskHostE2ETests",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    dependencies: [
        .package(path: "../.."),
    ],
    targets: [
        .target(
            name: "E2ETestSupport",
            dependencies: kioskProducts
        ),
        .testTarget(
            name: "E2ETier1Tests",
            dependencies: ["E2ETestSupport"] + kioskProducts
        ),
        .testTarget(
            name: "E2ETier2Tests",
            dependencies: ["E2ETestSupport"] + kioskProducts
        ),
        .testTarget(
            name: "E2ETier3Tests",
            dependencies: ["E2ETestSupport"] + kioskProducts
        ),
        .testTarget(
            name: "E2ETier4Tests",
            dependencies: ["E2ETestSupport"] + kioskProducts
        ),
    ]
)
