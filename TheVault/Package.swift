// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TheVault",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "VaultCore", targets: ["VaultCore"]),
        .executable(name: "vault", targets: ["vault"])
    ],
    targets: [
        .target(name: "VaultCore"),
        .executableTarget(
            name: "vault",
            dependencies: ["VaultCore"]
        ),
        .testTarget(
            name: "VaultCoreTests",
            dependencies: ["VaultCore"],
            resources: [.copy("Fixtures")]
        )
    ]
)
