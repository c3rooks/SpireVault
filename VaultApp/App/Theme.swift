import SwiftUI
import VaultCore

/// Centralized palette + reusable styling. Mirrors Ascension Companion so the
/// two products feel like the same product family — same ember accent, same
/// midnight panels, same gold highlights for "best" callouts.
enum Theme {

    // MARK: - Core palette (matches the iOS Companion app)

    static let bgDeep        = Color(hex: "#070710")  // window edges
    static let bgPrimary     = Color(hex: "#0D0D0D")  // main background
    static let bgSidebar     = Color(hex: "#0A0A1A")  // sidebar
    static let cardBG        = Color(hex: "#1A1A2E")  // raised panels
    static let cardBGRaised  = Color(hex: "#22223D")  // hover / nested
    static let cardBorder    = Color(hex: "#2A2A4E")  // panel stroke
    static let cardBorderHi  = Color(hex: "#3A3A6E")  // active / hover stroke

    static let accent        = Color(hex: "#E65100")  // ember
    static let accentBright  = Color(hex: "#FF7A1A")  // glow
    static let accentSoft    = Color(hex: "#E65100").opacity(0.18)
    static let gold          = Color(hex: "#FFD54F")
    static let goldSoft      = Color(hex: "#FFD54F").opacity(0.20)

    static let win           = Color(hex: "#2E7D32")
    static let winBright     = Color(hex: "#4CAF50")
    static let loss          = Color(hex: "#C62828")
    static let lossBright    = Color(hex: "#E53935")

    static let text          = Color.white
    static let textPrimary   = Color.white
    static let textSecondary = Color.white.opacity(0.65)
    static let textTertiary  = Color.white.opacity(0.40)

    static let accentDeep    = Color(hex: "#B23800")  // deep ember for gradient bottoms

    // MARK: - Character colors (matches GameModels.swift in the iOS app)

    static func characterColor(_ c: VaultCore.Character?) -> Color {
        switch c {
        case .ironclad:    return Color(hex: "#C62828")
        case .silent:      return Color(hex: "#2E7D32")
        case .regent:      return Color(hex: "#F9A825")
        case .necrobinder: return Color(hex: "#6A1B9A")
        case .defect:      return Color(hex: "#1565C0")
        default:           return Color(hex: "#9E9E9E")
        }
    }

    static func characterColor(forKey key: String) -> Color {
        characterColor(VaultCore.Character.from(key))
    }

    static func characterIcon(_ c: VaultCore.Character?) -> String {
        switch c {
        case .ironclad:    return "shield.lefthalf.filled"
        case .silent:      return "leaf.fill"
        case .regent:      return "crown.fill"
        case .necrobinder: return "moonphase.waning.crescent"
        case .defect:      return "bolt.circle.fill"
        default:           return "questionmark.circle"
        }
    }

    // MARK: - Hex helper
}

extension Color {
    init(hex raw: String) {
        let hex = raw.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r, g, b: UInt64
        switch hex.count {
        case 6: (r, g, b) = (int >> 16, int >> 8 & 0xFF, int & 0xFF)
        default: (r, g, b) = (255, 255, 255)
        }
        self.init(.sRGB, red: Double(r)/255, green: Double(g)/255, blue: Double(b)/255, opacity: 1)
    }
}

// MARK: - Reusable card / panel styles

struct PremiumPanel: ViewModifier {
    var padding: CGFloat = 20
    var cornerRadius: CGFloat = 14
    var stroke: Color = Theme.cardBorder
    var fill: Color = Theme.cardBG

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(fill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(stroke, lineWidth: 1)
            )
    }
}

extension View {
    func premiumPanel(padding: CGFloat = 20, cornerRadius: CGFloat = 14, stroke: Color = Theme.cardBorder, fill: Color = Theme.cardBG) -> some View {
        modifier(PremiumPanel(padding: padding, cornerRadius: cornerRadius, stroke: stroke, fill: fill))
    }
}

// MARK: - Section header (label + accent underline)

struct SectionTitle: View {
    let text: String
    var systemImage: String?
    var accent: Color = Theme.accent

    init(_ text: String, systemImage: String? = nil, accent: Color = Theme.accent) {
        self.text = text
        self.systemImage = systemImage
        self.accent = accent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(accent)
                }
                Text(text.uppercased())
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .tracking(2)
                    .foregroundStyle(Theme.textSecondary)
            }
            Rectangle()
                .fill(LinearGradient(colors: [accent, accent.opacity(0)], startPoint: .leading, endPoint: .trailing))
                .frame(width: 80, height: 1.5)
        }
    }
}

// MARK: - Pill tag

struct Pill: View {
    let text: String
    var tint: Color = Theme.accent
    var bold: Bool = true

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: bold ? .heavy : .semibold, design: .rounded))
            .tracking(1)
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(tint.opacity(0.18))
            )
            .overlay(
                Capsule().stroke(tint.opacity(0.35), lineWidth: 0.5)
            )
    }
}

// MARK: - Title-cased prettifier for ids

enum Prettify {
    static func id(_ s: String) -> String {
        var s = s
        var suffix = ""
        if let plusIdx = s.firstIndex(of: "+") {
            suffix = " " + String(s[plusIdx...])
            s = String(s[..<plusIdx])
        }
        let parts = s.split(separator: "_").map { piece -> String in
            piece.prefix(1).uppercased() + piece.dropFirst()
        }
        return parts.joined(separator: " ") + suffix
    }

    static func percent(_ d: Double) -> String { String(format: "%.1f%%", d * 100) }
    static func percentInt(_ d: Double) -> String { String(format: "%.0f%%", d * 100) }
}
