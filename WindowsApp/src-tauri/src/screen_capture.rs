// screen_capture.rs
// ─────────────────────────────────────────────────────────────────────────────
// Screen capture for the Run Coach AI — Windows equivalent of the macOS
// `CGDisplayCreateImage` call in OverlayAIService.captureActiveDisplayPNG().
//
// Uses the `screenshots` crate which wraps DXGI/GDI on Windows, IOSurface on
// macOS, and XCB/randr on Linux — so this module compiles cross-platform
// (useful when building on macOS for the CI check step).
//
// Privacy: screenshots are taken in-memory only, immediately base64-encoded,
// and sent directly to the user's own AI provider. Nothing is written to disk.
// Matches the same posture documented in OverlayAIService.swift.
// ─────────────────────────────────────────────────────────────────────────────

use base64::{engine::general_purpose::STANDARD, Engine as _};
use screenshots::Screen;

/// Capture the primary display, downscale to max_dimension (longest side),
/// and return a base64-encoded PNG string ready to embed in an AI API call.
/// Returns `None` if capture is unavailable (no Screen Recording permission, etc.).
pub fn capture_primary_display_b64(max_dimension: u32) -> Option<String> {
    let screens = Screen::all().ok()?;
    // Pick the primary/first display — same as `CGMainDisplayID()` on macOS.
    let screen = screens.into_iter().next()?;
    let image = screen.capture().ok()?;

    // Downscale if needed. The `screenshots` crate returns an `image::RgbaImage`.
    let (w, h) = (image.width(), image.height());
    let scale = if w > max_dimension || h > max_dimension {
        max_dimension as f32 / (w.max(h)) as f32
    } else {
        1.0
    };

    let resized = if scale < 1.0 {
        let new_w = (w as f32 * scale) as u32;
        let new_h = (h as f32 * scale) as u32;
        // Use the imageops fast scaling — matches macOS quality.
        image::imageops::resize(
            &image,
            new_w,
            new_h,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };

    // Encode to PNG in memory.
    let mut buf: Vec<u8> = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buf);
    encoder
        .encode(
            resized.as_raw(),
            resized.width(),
            resized.height(),
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;

    Some(STANDARD.encode(&buf))
}
