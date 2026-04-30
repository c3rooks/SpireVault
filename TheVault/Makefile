.PHONY: all build release test test-quiet run install uninstall clean lint

PREFIX ?= /usr/local
BIN     = vault

all: build

build:
	swift build

release:
	swift build -c release

test:
	swift test

test-quiet:
	swift test --quiet

run: release
	@.build/release/$(BIN) help

install: release
	install -d $(PREFIX)/bin
	install -m 755 .build/release/$(BIN) $(PREFIX)/bin/$(BIN)
	@echo "Installed $(PREFIX)/bin/$(BIN)"

uninstall:
	rm -f $(PREFIX)/bin/$(BIN)

clean:
	swift package clean
	rm -rf .build .swiftpm

lint:
	@command -v swiftlint >/dev/null 2>&1 \
	  && swiftlint lint --quiet \
	  || echo "swiftlint not installed, skipping"

# Convenience: scan + stats against current user save folder
demo: release
	@.build/release/$(BIN) doctor || true
	@echo "---"
	@.build/release/$(BIN) scan || true
	@echo "---"
	@.build/release/$(BIN) stats || true
