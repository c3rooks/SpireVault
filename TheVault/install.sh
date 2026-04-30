#!/usr/bin/env bash
# One-line installer for The Vault.
# Usage:
#   ./install.sh              # builds release, installs to /usr/local/bin
#   PREFIX=$HOME/.local ./install.sh
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
BIN="vault"

if ! command -v swift >/dev/null 2>&1; then
    echo "error: swift toolchain not found. Install Xcode 15+ or Swift 5.9+ first." >&2
    exit 1
fi

echo "→ building release binary"
swift build -c release

if [[ ! -x ".build/release/${BIN}" ]]; then
    echo "error: build did not produce .build/release/${BIN}" >&2
    exit 1
fi

target="${PREFIX}/bin/${BIN}"
echo "→ installing to ${target}"
mkdir -p "${PREFIX}/bin"
if [[ -w "${PREFIX}/bin" ]]; then
    install -m 755 ".build/release/${BIN}" "${target}"
else
    sudo install -m 755 ".build/release/${BIN}" "${target}"
fi

echo
echo "✓ installed. Try:"
echo "    ${BIN} discover"
echo "    ${BIN} doctor"
echo "    ${BIN} scan && ${BIN} stats"
