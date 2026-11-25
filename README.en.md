<div align="center">

<img src="docs/assets/app-icon.svg" alt="StikSound App Icon" width="120" height="120" />

# StickSound

> **Fork of [SilverFeit/StikSound](https://github.com/SilverFeit/StikSound), modified by [hweg000](https://github.com/hweg000).** Main changes: in-app sound search (MyInstants) and GIF search (Tenor), real transparent WebM on Chrome/Edge, drag, pinch and zoom framing, and a new design. The original code is © 2026 StikSound Contributors (SilverFeit) and is licensed under MIT or Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`); the modifications are released under the same licenses. The download buttons and web version below belong to the original project.

**Create 5s or 10s sound videos (with an on-screen toggle) from a PNG, JPG, WebP, or animated GIF: paste your sticker, pick a local audio file or a MyInstants link, trim the exact clip, and export everything 100% locally.**

[![Use on the Web](https://img.shields.io/badge/Use%20on%20the%20Web-GitHub%20Pages-0ea5e9?style=for-the-badge&logo=githubpages&logoColor=white)](https://silverfeit.github.io/StikSound/)
[![Download](https://img.shields.io/github/v/release/SilverFeit/StikSound?style=for-the-badge&label=Download&color=25D366)](https://github.com/SilverFeit/StikSound/releases/latest)

[![Platforms](https://img.shields.io/badge/Platforms-Web%20%7C%20Windows%20%7C%20macOS%20%7C%20Chrome-25D366?style=flat-square)](#web-version-vs-install)
[![Local Processing](https://img.shields.io/badge/Processing-100%25%20local-10b981?style=flat-square)](#privacy--security)
[![License](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-6366f1?style=flat-square)](LICENSE-MIT)

[**Use on the Web**](https://silverfeit.github.io/StikSound/) · [**Download**](https://github.com/SilverFeit/StikSound/releases/latest) · [**Step-by-Step Guide**](#step-by-step-guide) · [**How It Works**](#how-it-works-internally) · [**Development**](#development)

**🌐 Idioma / Language / Idioma:** [**🇪🇸 Español (Principal)**](README.md) · **🇺🇸 English** · [**🇧🇷 Português**](README.pt.md)

</div>

---

## 🌐 Web Version vs. Install

You can use **StikSound directly in your browser** with zero installation (works on PC, Android, and iPhone as a PWA), with one difference regarding **MyInstants**:

> [!IMPORTANT]
> **Web Version ([silverfeit.github.io/StikSound](https://silverfeit.github.io/StikSound/)):** works **only with audio files already downloaded** on your device (`MP3`, `WAV`, `M4A`, `OGG`, `AAC`) or the audio track of a short video clip.
>
> **Want to paste direct MyInstants links?** Because of browser CORS security rules, MyInstants blocks direct downloads from static web pages. To paste MyInstants URLs directly, **install** the [Desktop app (Windows/macOS) or Chrome Extension](https://github.com/SilverFeit/StikSound/releases/latest) — or download the MP3 from MyInstants first and pick it in the web app.

| Feature | 🌐 Web Version (GitHub Pages) | 💻 Desktop App / 🧩 Chrome Extension |
| --- | :---: | :---: |
| **Installation required** | ❌ None ([open now](https://silverfeit.github.io/StikSound/)) | ✅ [Download release](https://github.com/SilverFeit/StikSound/releases/latest) |
| **100% local processing** | ✅ | ✅ |
| **PNG / JPG / WebP / GIF stickers** | ✅ | ✅ |
| **Short video clips (`MP4`, `MOV`, `WebM`) as source** | ✅ | — |
| **`5s \| 10s` duration toggle** | ✅ | ✅ |
| **Downloaded local audio files** | ✅ | ✅ |
| **Paste direct MyInstants URLs** | ❌ *(download MP3 first)* | ✅ |
| **Transparent WebM export** | ❌ *(MP4 only on web/mobile)* | ✅ |

---

## What StikSound Does

StikSound combines **a square image** and **an audio clip** into a downloadable or copyable file. The maximum clip duration is controlled via the `5s | 10s` toggle (10 seconds by default). Everything runs locally on your device without uploading files to any external server.

- Supports **PNG, JPG/JPEG, WebP, and GIF** inputs (plus `MP4`, `MOV`, `WebM` clips on Web).
- Decodes **animated GIFs** frame by frame and loops them seamlessly across the exported video duration.
- Accepts local **MP3, WAV, OGG, M4A, or AAC** audio, or validated **MyInstants** links (Desktop & Chrome Extension).
- Supports **9 built-in UI languages** (`ES`, `EN`, `PT`, `FR`, `DE`, `IT`, `RU`, `ZH`, `AR`) selectable in the `⋯` menu.
- Exports compatible **MP4**, transparent **WebM**, portable **`.stiksound.zip`** bundles/projects, or static **WebP** (`<= 100 KB`).

> **Important note about WhatsApp:** The exported MP4 is a standard video, not a native animated sticker. Pasting or sharing it in chat sends it as a video. Only some undocumented Android beta accounts allow picking a video via *Create sticker* from the gallery (where WhatsApp controls duration and audio). The experimental `native-sound-sticker` profile remains disabled.

---

## Step-by-Step Guide

1. **Load a sticker:** Paste with `Ctrl + V` / `Cmd + V`, drag & drop, or click the center stage (`PNG`, `JPG`, `WebP`, `GIF`; plus short video clips on Web).
2. **Frame 1:1 crop:** Non-square inputs are centered automatically; move your mouse (or drag with your finger on mobile) to reposition the `1:1` crop up to `512 × 512 px` without upscaling.
3. **Add audio:** Drop an audio file, click **Audio**, or paste a valid MyInstants URL (Desktop/Extension). Source limits: max `25 MB` and `3 minutes`; export selection between `0.1 s` and `5 s` or `10 s` (for animated GIFs, the minimum duration is 1 GIF loop up to the active cap).
4. **Adjust trim & background:** Click the waveform or drag the trim slider, preview playback, and choose **Transparent** (WebM) or **White / Black / Custom color** (MP4) when alpha is present.
5. **Preview, copy, or download:** Use `➔` to render and copy/share, `⬇` to pick an explicit export format, `⋯` for project save/open, language selection, and About/licenses, and `✕` to reset.

---

## How It Works Internally

- **Image & GIF pipeline:** Sniffs actual file magic bytes, enforces decompression-bomb and GIF memory/frame limits (`300` frames max, `64 MiB` canvas, `256 MiB` aggregate RGBA), computes 1:1 crop, and schedules looping GIF frames matched to browser preview delays.
- **Audio pipeline:** Decodes audio, mixes to mono, computes 1024 waveform peak buckets, trims integer `start_ms`–`end_ms`, and resamples to **48 kHz mono**.
- **Video encoding:** Uses **WebCodecs (`VideoEncoder` + `AudioEncoder`) + pure-TS `mp4-muxer` / `webm-muxer`** when supported, falling back to **Canvas + `MediaRecorder`** where needed.

---

## Repository Layout

```text
apps/
  desktop/       Tauri app for Windows/macOS
  extension/     Chrome Manifest V3 extension
  web/           Web App / PWA deployed on GitHub Pages
packages/
  core/          Project model, invariants, validation & use cases
  ui/            Shared React editor, trim bar & 9-language i18n
  media-web/     TypeScript sniffing, decoding, trim, waveform, mux & ZIP
  providers/     MyInstants URL policy & resolution
crates/
  audio-engine/  Rust audio probing/decoding/trim
  image-engine/  Rust image/GIF probing & utilities
  video-engine/  Rust video validation & mux utilities
  project-store/ Rust atomic file & package store
docs/            Requirements, architecture, specs & decisions
```

---

## Installation

### Windows & macOS
1. Open [**Releases**](https://github.com/SilverFeit/StikSound/releases/latest).
2. Download the installer or binary for your platform (`windows-x64` or `macos-universal`).
3. Launch StikSound — no FFmpeg or external tools required. *(On macOS, right-click → **Open** if Gatekeeper prompts for an unsigned developer).*

### Chrome / Edge / Brave Extension
1. Download `StikSound-*-chrome-extension.zip` from [**Releases**](https://github.com/SilverFeit/StikSound/releases/latest) and unzip it.
2. Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the extracted folder.

---

## Privacy & Security

- Zero backend servers receive your images, videos, or audio files.
- All media processing runs locally on your device.
- The only network request is MyInstants resolution (Desktop & Chrome Extension only), restricted by strict HTTPS allowlist, redirect cap, IP filtering (blocking private/loopback ranges in Rust), and 25 MB / 20 s limits.

---

## Development

```bash
git clone https://github.com/SilverFeit/StikSound.git
cd StikSound
npm install
npm run typecheck
npm test
npm run build
cargo test --workspace --exclude stiksound-desktop
```

## License

Dual-licensed under either **MIT License** ([LICENSE-MIT](LICENSE-MIT)) or **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE)), at your option (`MIT OR Apache-2.0`).
