import SwiftUI
import AppKit
import VaultCore

/// Beautiful, shareable summary of a single run. Renders to PNG via SwiftUI's
/// `ImageRenderer`, ready to drop into Discord, Reddit, X, or anywhere else.
///
/// Two output flavours:
/// - PNG (Save / Copy Image)        — for visual platforms
/// - Markdown (Copy as text)        — for Discord embeds and Reddit posts
struct ShareCard: View {
    let run: RunRecord

    private var character: VaultCore.Character? { run.character }
    private var color: Color { Theme.characterColor(character) }
    private var icon: String { Theme.characterIcon(character) }

    var body: some View {
        ZStack {
            // Solid dark base — never use translucency in shared images.
            Theme.bgPrimary

            // Subtle character-tinted radial in the corner for depth
            RadialGradient(
                colors: [color.opacity(0.30), .clear],
                center: .topLeading,
                startRadius: 40, endRadius: 520
            )

            VStack(alignment: .leading, spacing: 18) {
                header
                Divider().background(Theme.cardBorder)
                deckRelicsBlock
                Spacer(minLength: 0)
                footer
            }
            .padding(28)
        }
        .frame(width: 880, height: 540)
        .background(Theme.bgPrimary)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(color.opacity(0.4), lineWidth: 1.5)
        )
        // Character-colored stripe down the very left edge
        .overlay(alignment: .leading) {
            Rectangle().fill(color).frame(width: 6)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 18) {
            // Character glyph
            Image(systemName: icon)
                .font(.system(size: 36, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 78, height: 78)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(color.opacity(0.18))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(color.opacity(0.5), lineWidth: 1.5)
                )

            VStack(alignment: .leading, spacing: 6) {
                Text(character.map { Prettify.id($0.rawValue) } ?? "Unknown")
                    .font(.system(size: 32, weight: .heavy, design: .rounded))
                    .foregroundStyle(Theme.text)

                HStack(spacing: 8) {
                    if let asc = run.ascension {
                        Pill(text: "ASCENSION \(asc)", tint: Theme.gold)
                    }
                    if let f = run.floorReached {
                        Pill(text: "FLOOR \(f)", tint: Theme.textSecondary, bold: false)
                    }
                    if let dur = run.playTimeSeconds {
                        Pill(text: formatDuration(dur), tint: Theme.textSecondary, bold: false)
                    }
                    if let date = run.endedAt ?? run.startedAt {
                        Text(date.formatted(date: .abbreviated, time: .omitted))
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
            }

            Spacer()

            outcomeBadge
        }
    }

    private var outcomeBadge: some View {
        let isWin = run.won == true
        return VStack(spacing: 6) {
            Text(isWin ? "VICTORY" : "DEFEAT")
                .font(.system(size: 22, weight: .heavy, design: .rounded))
                .tracking(4)
                .foregroundStyle(isWin ? Theme.winBright : Theme.lossBright)
            if let seed = run.seed {
                Text("SEED \(seed)")
                    .font(.system(size: 9, weight: .heavy, design: .rounded).monospaced())
                    .tracking(1.5)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill((isWin ? Theme.win : Theme.loss).opacity(0.20))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke((isWin ? Theme.win : Theme.loss).opacity(0.5), lineWidth: 1)
        )
    }

    private var deckRelicsBlock: some View {
        HStack(alignment: .top, spacing: 24) {
            relicsColumn
            deckColumn
        }
    }

    private var relicsColumn: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(Theme.gold).font(.system(size: 12, weight: .bold))
                Text("RELICS · \(run.relics.count)")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .tracking(2).foregroundStyle(Theme.textSecondary)
            }
            ForEach(run.relics.prefix(8), id: \.self) { id in
                HStack(spacing: 6) {
                    Circle().fill(Theme.gold).frame(width: 4, height: 4)
                    Text(Prettify.id(id))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                }
            }
            if run.relics.count > 8 {
                Text("+ \(run.relics.count - 8) more")
                    .font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var deckColumn: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.stack.fill").foregroundStyle(color).font(.system(size: 12, weight: .bold))
                Text("DECK · \(run.deckAtEnd.count) CARDS")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .tracking(2).foregroundStyle(Theme.textSecondary)
            }
            // Show the most interesting cards first: anything upgraded, then unique non-strike/defend.
            ForEach(highlightCards.prefix(10), id: \.self) { id in
                HStack(spacing: 6) {
                    Circle().fill(color).frame(width: 4, height: 4)
                    Text(Prettify.id(id))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(id.contains("+") ? Theme.gold : Theme.text)
                        .lineLimit(1)
                }
            }
            if highlightCards.count > 10 {
                Text("+ \(highlightCards.count - 10) more")
                    .font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var highlightCards: [String] { ShareCard.highlightCards(for: run) }

    /// Reorder deck for share-card display: upgrades first, then non-basic cards.
    /// Strikes/Defends drop to the bottom — they're not what people want to see.
    static func highlightCards(for run: RunRecord) -> [String] {
        let basic: Set<String> = ["strike", "strike_red", "strike_silent", "strike_defect",
                                  "strike_regent", "strike_necrobinder",
                                  "defend", "defend_red", "defend_silent", "defend_defect",
                                  "defend_regent", "defend_necrobinder"]
        let withUpgrades = run.deckAtEnd.filter { $0.contains("+") }
        let nonBasic = run.deckAtEnd.filter {
            !$0.contains("+") && !basic.contains($0)
        }
        let basicCards = run.deckAtEnd.filter {
            !$0.contains("+") && basic.contains($0)
        }
        return Array(NSOrderedSet(array: withUpgrades + nonBasic + basicCards)) as? [String] ?? []
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Image(systemName: "shield.lefthalf.filled")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.accent)
            Text("THE VAULT")
                .font(.system(size: 11, weight: .heavy, design: .rounded))
                .tracking(3).foregroundStyle(Theme.text)
            Text("· run tracker for Slay the Spire 2")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
            Spacer()
            Text("github.com/c3rooks/SpireVault")
                .font(.system(size: 10, weight: .semibold).monospaced())
                .foregroundStyle(Theme.textTertiary)
        }
    }

    private func formatDuration(_ sec: Int) -> String {
        let m = sec / 60
        let s = sec % 60
        return String(format: "%d:%02d", m, s)
    }
}

// MARK: - Share preview sheet (the modal)

struct ShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    let run: RunRecord
    @State private var copyState: CopyState = .idle

    enum CopyState: Equatable {
        case idle
        case copiedImage
        case copiedMarkdown
        case savedTo(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("SHARE RUN")
                    .font(.system(size: 12, weight: .heavy, design: .rounded))
                    .tracking(3).foregroundStyle(Theme.textSecondary)
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(Theme.textSecondary)
                }
                .buttonStyle(.plain)
            }

            // Live preview, scaled down so it fits a sheet
            ShareCard(run: run)
                .scaleEffect(0.62, anchor: .center)
                .frame(width: 880 * 0.62, height: 540 * 0.62)
                .frame(maxWidth: .infinity)

            HStack(spacing: 10) {
                ShareButton(label: "Copy Image", systemImage: "doc.on.doc", primary: true) {
                    if copyImageToPasteboard() { transient(.copiedImage) }
                }
                ShareButton(label: "Save PNG…", systemImage: "square.and.arrow.down") {
                    if let path = savePNG() { transient(.savedTo(path)) }
                }
                ShareButton(label: "Copy Markdown", systemImage: "text.alignleft") {
                    copyMarkdownToPasteboard()
                    transient(.copiedMarkdown)
                }
            }

            statusLine
        }
        .padding(24)
        .frame(width: 620)
        .background(Theme.bgPrimary)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var statusLine: some View {
        switch copyState {
        case .idle:
            EmptyView()
        case .copiedImage:
            statusBadge("Image copied to clipboard — paste it directly in Discord", color: Theme.win)
        case .copiedMarkdown:
            statusBadge("Markdown copied — paste in Discord, Reddit, or any chat", color: Theme.win)
        case .savedTo(let path):
            statusBadge("Saved: \(path)", color: Theme.win)
        }
    }

    private func statusBadge(_ text: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(color)
            Text(text)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func transient(_ s: CopyState) {
        copyState = s
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            if copyState == s { copyState = .idle }
        }
    }

    // MARK: - Render & export

    @MainActor
    private func renderImage() -> NSImage? {
        let renderer = ImageRenderer(content: ShareCard(run: run).frame(width: 880, height: 540))
        renderer.scale = 2.0  // Retina-friendly export
        return renderer.nsImage
    }

    @MainActor
    private func renderPNG() -> Data? {
        guard let image = renderImage(),
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let data = rep.representation(using: .png, properties: [:])
        else { return nil }
        return data
    }

    @MainActor
    private func copyImageToPasteboard() -> Bool {
        guard let image = renderImage() else { return false }
        let pb = NSPasteboard.general
        pb.clearContents()
        return pb.writeObjects([image])
    }

    @MainActor
    private func savePNG() -> String? {
        guard let data = renderPNG() else { return nil }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = "vault-\(run.id).png"
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        try? data.write(to: url)
        return url.path
    }

    private func copyMarkdownToPasteboard() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(markdown, forType: .string)
    }

    /// A clean Markdown rendering for Discord / Reddit. Discord renders
    /// **bold** and code blocks but not headings, so we lean on bold + emoji.
    private var markdown: String {
        let charName = run.character.map { Prettify.id($0.rawValue) } ?? "Unknown"
        let outcome = run.won == true ? "✅ **VICTORY**" : "💀 **DEFEAT**"
        let asc = run.ascension.map { "A\($0)" } ?? "?"
        let floor = run.floorReached.map { "f\($0)" } ?? "?"
        let dur = run.playTimeSeconds.map { sec -> String in
            let m = sec / 60, s = sec % 60
            return String(format: "%d:%02d", m, s)
        } ?? "?"
        let topRelics = run.relics.prefix(6).map { "`\(Prettify.id($0))`" }.joined(separator: ", ")
        let topCards = ShareCard.highlightCards(for: run).prefix(8).map { "`\(Prettify.id($0))`" }.joined(separator: ", ")
        return """
        \(outcome) — **\(charName)** · \(asc) · \(floor) · \(dur)
        **Relics (\(run.relics.count)):** \(topRelics)
        **Deck (\(run.deckAtEnd.count)):** \(topCards)
        _via The Vault — github.com/c3rooks/SpireVault_
        """
    }
}

private struct ShareButton: View {
    let label: String
    let systemImage: String
    var primary: Bool = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage).font(.system(size: 11, weight: .semibold))
                Text(label).font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(primary ? Theme.text : (hover ? Theme.text : Theme.textSecondary))
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(primary ? Theme.accent : (hover ? Theme.cardBGRaised : Theme.cardBG))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(primary ? Theme.accent : Theme.cardBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
