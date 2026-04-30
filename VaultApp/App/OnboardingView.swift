import SwiftUI
import VaultCore

struct OnboardingView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        ZStack {
            Theme.bgPrimary.ignoresSafeArea()

            // Subtle ember radial in the corner
            RadialGradient(
                colors: [Theme.accent.opacity(0.18), .clear],
                center: .topLeading,
                startRadius: 50, endRadius: 480
            )
            .ignoresSafeArea()

            VStack(spacing: 28) {
                VStack(spacing: 16) {
                    Image("VaultEmblem")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 132, height: 132)
                        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 26, style: .continuous)
                                .stroke(Theme.gold.opacity(0.5), lineWidth: 1.5)
                        )
                        .shadow(color: Theme.accent.opacity(0.55), radius: 24, x: 0, y: 6)
                    VStack(spacing: 4) {
                        Text("THE VAULT")
                            .font(.system(size: 34, weight: .heavy, design: .serif))
                            .tracking(6)
                            .foregroundStyle(
                                LinearGradient(colors: [Theme.gold, Theme.accentBright],
                                               startPoint: .leading, endPoint: .trailing)
                            )
                        Text("for Slay the Spire 2")
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .tracking(3)
                            .foregroundStyle(Theme.accent)
                    }
                    Text("Track every run. Find skill-matched co-op partners. Never touches your saves.")
                        .font(.system(size: 13))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 460)
                        .foregroundStyle(Theme.textSecondary)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("PICK YOUR SAVE FOLDER")
                        .font(.system(size: 10, weight: .heavy, design: .rounded))
                        .tracking(2)
                        .foregroundStyle(Theme.textTertiary)
                    Text("On macOS this is usually:")
                        .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                    Text("~/Library/Application Support/Steam/userdata/<id>/2868840/remote")
                        .font(.system(size: 11, design: .monospaced))
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 8).fill(Theme.bgDeep)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8).stroke(Theme.cardBorder, lineWidth: 1)
                        )
                        .foregroundStyle(Theme.text)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: 540)
                .premiumPanel(padding: 18, cornerRadius: 14)

                HStack(spacing: 10) {
                    Button {
                        state.chooseSaveFolder()
                    } label: {
                        Label("Choose Folder…", systemImage: "folder")
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .controlSize(.large)

                    Button {
                        state.saveFolder = SaveFolderLocator.resolve()
                        if state.saveFolder != nil {
                            state.needsOnboarding = false
                            Task { await state.scan() }
                        }
                    } label: {
                        Label("Auto-Detect", systemImage: "sparkles")
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 4)
                    }
                    .controlSize(.large)
                }
            }
            .padding(40)
        }
        .preferredColorScheme(.dark)
    }
}
