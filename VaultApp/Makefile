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
build: gen
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
	xcodegen generate
	-xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Release \
	  -derivedDataPath $(BUILD) CODE_SIGN_IDENTITY="$${CODE_SIGN_IDENTITY:--}" \
	  build > $(BUILD)/last-release.log 2>&1
	@if [ ! -d "$(RELEASE_APP_PATH)" ]; then \
	  echo "Release build failed. See $(BUILD)/last-release.log"; \
	  tail -40 $(BUILD)/last-release.log; \
	  exit 1; \
	fi
	-xattr -dr com.apple.FinderInfo "$(RELEASE_APP_PATH)" 2>/dev/null
	-xattr -dr com.apple.provenance "$(RELEASE_APP_PATH)" 2>/dev/null
	codesign --force --deep --sign "$${CODE_SIGN_IDENTITY:--}" "$(RELEASE_APP_PATH)"
	@echo "→ Release app: $(RELEASE_APP_PATH)"
	@echo "→ Version:     $(VERSION)"

dmg: release
	@rm -rf "$(DMG_DIR)" "$(DMG_OUT)"
	@mkdir -p "$(DMG_DIR)"
	cp -R "$(RELEASE_APP_PATH)" "$(DMG_DIR)/"
	ln -sf /Applications "$(DMG_DIR)/Applications"
	hdiutil create -volname "The Vault $(VERSION)" \
	  -srcfolder "$(DMG_DIR)" -ov -format UDZO "$(DMG_OUT)"
	@echo "→ DMG: $(DMG_OUT)"
