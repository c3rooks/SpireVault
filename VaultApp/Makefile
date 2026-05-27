.PHONY: all gen build sign run clean rebuild release dmg

PROJECT = TheVault.xcodeproj
SCHEME  = TheVault
CONFIG  = Debug
BUILD   = build
APP     = $(BUILD)/Build/Products/$(CONFIG)/The\ Vault.app

# For release / DMG targets
RELEASE_APP = $(BUILD)/Build/Products/Release/The\ Vault.app
RELEASE_APP_PATH = $(BUILD)/Build/Products/Release/The Vault.app
VERSION ?= $(shell /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$(RELEASE_APP_PATH)/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
DMG_DIR    = $(BUILD)/dmg
DMG_NAME   = The-Vault-$(VERSION).dmg
DMG_OUT    = $(BUILD)/$(DMG_NAME)

all: run

gen:
	xcodegen generate

# Build via xcodebuild. Codesign step often fails on a fresh build because
# Xcode tags the bundle root with com.apple.FinderInfo which codesign refuses
# — we strip it and re-sign in `sign`. The build itself still completes
# successfully, so we tolerate xcodebuild's nonzero exit.
#
# The `mkdir -p $(BUILD)` is required for the output redirect to succeed on
# a clean checkout (e.g. CI runners) — bash evaluates the `> file` redirect
# BEFORE running xcodebuild, so a missing parent dir aborts the step early.
build: gen
	@mkdir -p $(BUILD)
	-xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration $(CONFIG) \
	  -derivedDataPath $(BUILD) CODE_SIGN_IDENTITY="-" build > $(BUILD)/last-build.log 2>&1
	@if [ ! -d $(APP) ]; then \
	  echo "Build failed. See $(BUILD)/last-build.log"; \
	  tail -40 $(BUILD)/last-build.log; \
	  exit 1; \
	fi

sign:
	-xattr -d com.apple.FinderInfo $(APP) 2>/dev/null
	-xattr -d com.apple.provenance $(APP) 2>/dev/null
	codesign --force --deep --sign - $(APP)

run: build sign
	@osascript -e 'quit app "The Vault"' 2>/dev/null || true
	@sleep 0.5
	open $(APP)

rebuild: clean run

clean:
	rm -rf $(BUILD)

# -----------------------------------------------------------------------------
# Release pipeline — produces a signed Release .app and a draggable DMG.
# Override CODE_SIGN_IDENTITY=<Developer ID> on the command line to ship a
# notarizable build; default ad-hoc signing is fine for "right-click -> Open".
# -----------------------------------------------------------------------------

release:
	@mkdir -p $(BUILD)
	xcodegen generate
	-xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Release \
	  -derivedDataPath $(BUILD) CODE_SIGN_IDENTITY="$${CODE_SIGN_IDENTITY:--}" \
	  build > $(BUILD)/last-release.log 2>&1
	@if [ ! -d "$(RELEASE_APP_PATH)" ]; then \
	  echo "Release build failed. See $(BUILD)/last-release.log"; \
	  tail -40 $(BUILD)/last-release.log; \
	  exit 1; \
	fi
	# Strip every extended attribute (FinderInfo, provenance, quarantine, …)
	# before signing — codesign refuses to sign a bundle that has any leftover.
	# `xattr -cr` does this recursively and is a hard requirement on macOS 14+.
	xattr -cr "$(RELEASE_APP_PATH)"
	codesign --force --deep --sign "$${CODE_SIGN_IDENTITY:--}" "$(RELEASE_APP_PATH)"
	codesign --verify --verbose=2 "$(RELEASE_APP_PATH)"
	@echo "→ Release app: $(RELEASE_APP_PATH)"
	@echo "→ Version:     $(VERSION)"

dmg: release
	@rm -rf "$(DMG_DIR)" "$(DMG_OUT)"
	@mkdir -p "$(DMG_DIR)"
	cp -R "$(RELEASE_APP_PATH)" "$(DMG_DIR)/"
	# Strip quarantine so dragging from this DMG to /Applications
	# doesn't trigger macOS App Translocation (which would silently
	# run the OLD cached copy instead of the freshly installed one).
	xattr -dr com.apple.quarantine "$(DMG_DIR)/The Vault.app" 2>/dev/null || true
	ln -sf /Applications "$(DMG_DIR)/Applications"
	hdiutil create -volname "The Vault $(VERSION)" \
	  -srcfolder "$(DMG_DIR)" -ov -format UDZO "$(DMG_OUT)"
	@echo "→ DMG: $(DMG_OUT)"
	@# Sync to the local marketing site so `make dmg` + refresh browser
	@# always serves the current build — no manual copy needed.
	@SITE_ASSET="$(shell dirname $(CURDIR))/Site/assets/The.Vault.dmg"; \
	 if [ -d "$$(dirname $$SITE_ASSET)" ]; then \
	   cp "$(DMG_OUT)" "$$SITE_ASSET" && echo "→ Site asset updated: $$SITE_ASSET"; \
	 fi

# -----------------------------------------------------------------------------
# Notarization
# -----------------------------------------------------------------------------
# You must set APPLE_ID, APPLE_TEAM_ID, and APPLE_PASSWORD (app-specific password)
# in your environment to run this.
notarize: dmg
	@echo "→ Notarizing $(DMG_OUT)..."
	xcrun notarytool submit "$(DMG_OUT)" \
	  --apple-id "$$APPLE_ID" \
	  --team-id "$$APPLE_TEAM_ID" \
	  --password "$$APPLE_PASSWORD" \
	  --wait
	@echo "→ Stapling ticket to DMG..."
	xcrun stapler staple "$(DMG_OUT)"
