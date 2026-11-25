// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StikSoundError, type MediaEngine, type SoundProvider } from "@stiksound/core";
import { StikSoundMinimalApp, TimelineTrimBar } from "../src/index";

// jsdom has no microphone: pretend the APIs exist and hand back a fake take.
const recordingMock = vi.hoisted(() => ({
  stop: vi.fn(async () => new Uint8Array([0x52, 0x49, 0x46, 0x46])),
  cancel: vi.fn()
}));
vi.mock("../src/components/recording", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/recording")>()),
  canRecordAudio: () => true,
  startRecording: vi.fn(async () => recordingMock)
}));

afterEach(() => {
  cleanup();
});

function createTestEngine(width = 800, height = 400, isGif = false): MediaEngine {
  return {
    async probeImage() {
      return {
        format: isGif ? "gif" : "png",
        width,
        height,
        has_alpha: true,
        animated: isGif,
        frame_count: isGif ? 6 : 1,
        duration_ms: isGif ? 1200 : 0
      };
    },
    async renderSticker() {
      return { width: 400, height: 400, data: new Uint8Array(400 * 400 * 4) };
    },
    async encodeWebp() {
      return new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    },
    async probeAudio() {
      return { format: "mp3", duration_ms: 12_000, sample_rate: 44100, channels: 2 };
    },
    async waveform() {
      return {
        buckets: 1024,
        mins: new Float32Array(1024).fill(-0.4),
        maxs: new Float32Array(1024).fill(0.4)
      };
    },
    async renderAudio(_bytes, edit) {
      return {
        sampleRate: 48000,
        channels: 1,
        samples: new Float32Array(48000),
        durationMs: edit.end_ms - edit.start_ms
      };
    },
    async encodeOpus() {
      return new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    },
    async renderVideo(req) {
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: req.container === "webm-alpha" ? "video/webm" : "video/mp4",
        extension: req.container === "webm-alpha" ? "webm" : "mp4",
        durationMs: req.endMs - req.startMs,
        hasAlpha: req.container === "webm-alpha"
      };
    },
    async zip() {
      return new Uint8Array([0x50, 0x4b]);
    },
    async unzip() {
      return [];
    }
  };
}

describe("StikSoundMinimalApp UI", () => {
  it("supports GIF/PNG, zero-click hover 1:1 crop, arrow preview/copy, download format picker, and X reset", async () => {
    const saveArtifact = vi.fn().mockResolvedValue(undefined);
    const copyArtifactToClipboard = vi.fn().mockResolvedValue(undefined);
    const provider: SoundProvider = {
      id: "myinstants",
      canResolve: (u) => u.includes("myinstants.com"),
      resolve: async (u) => ({
        page_url: u,
        media_url: "https://www.myinstants.com/media/sounds/test.mp3",
        title: "Test Sound",
        bytes: new Uint8Array([0x49, 0x44, 0x33, 0x03])
      })
    };

    const { container } = render(
      <StikSoundMinimalApp
        engine={createTestEngine(800, 400, true)}
        providers={[provider]}
        shell={{ saveArtifact, copyArtifactToClipboard }}
        initialLocale="es"
      />
    );

    const okArrowBtn = screen.getByTestId("export-ok-btn") as HTMLButtonElement;
    expect(okArrowBtn.disabled).toBe(true);
    // The top-bar download button is gone; the arrow (share) is the only export action up there.
    expect(screen.queryByTestId("download-btn")).toBeNull();

    // Drop a non-square 800x400 GIF onto the center sticker zone
    const stickerZone = screen.getByTestId("sticker-zone");
    Object.defineProperty(stickerZone, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 })
    });
    const gifFile = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "dance.gif", { type: "image/gif" });
    Object.defineProperty(gifFile, "arrayBuffer", {
      value: async () => new Uint8Array([0x47, 0x49, 0x46, 0x38]).buffer
    });
    fireEvent.drop(stickerZone, { dataTransfer: { files: [gifFile] } });

    await waitFor(() => expect(screen.getByTestId("sticker-loaded-badge")).toBeTruthy());
    // Resolution badge shows input-driven 1:1 400x400 + hover hint
    expect(screen.getByTestId("resolution-pill").textContent).toContain("400×400");
    // Transparency picker is shown directly when alpha exists
    expect(screen.getByTestId("transparency-picker")).toBeTruthy();

    // Zero-click hover move to right side updates crop without any click
    fireEvent.mouseMove(stickerZone, { clientX: 200, clientY: 100 });

    // Submit MyInstants URL in bottom timeline bar
    const urlInput = screen.getByTestId("myinstants-url-input");
    fireEvent.change(urlInput, { target: { value: "https://www.myinstants.com/en/instant/test/" } });
    fireEvent.submit(urlInput.closest("form")!);

    await waitFor(() => expect(screen.getByTestId("duration-readout").textContent).toContain("10.0s / 10.0s"));
    expect(okArrowBtn.disabled).toBe(false);

    // Click Arrow (➔) -> generates most compatible preview & copies to clipboard without downloading
    fireEvent.click(okArrowBtn);
    await waitFor(() => expect(copyArtifactToClipboard).toHaveBeenCalledTimes(1));
    expect(copyArtifactToClipboard.mock.calls[0]![0].profile).toBe("video-mp4");
    expect(saveArtifact).not.toHaveBeenCalled();
    expect(screen.getByTestId("video-preview-ready")).toBeTruthy();

    // "Guardar" on the ready card opens the format picker; pick High Quality / Transparent WebM
    fireEvent.click(screen.getByTestId("preview-download-btn"));
    expect(screen.getByTestId("download-format-picker")).toBeTruthy();
    fireEvent.click(screen.getByTestId("download-fmt-video-webm-alpha"));
    await waitFor(() => expect(saveArtifact).toHaveBeenCalledTimes(1));
    expect(saveArtifact.mock.calls[0]![0].profile).toBe("video-webm-alpha");

    // Click X (✕) -> resets everything back to 0
    fireEvent.click(screen.getByTestId("reset-all-btn"));
    await waitFor(() => expect(screen.getByTestId("myinstants-url-input")).toBeTruthy());
    expect(okArrowBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="sticker-loaded-badge"]')).toBeNull();
  });

  it("preserves a shorter saved trim when repositioning audio under the 10s cap", () => {
    const onChangeRange = vi.fn();
    render(
      <TimelineTrimBar
        hasAudio
        durationMs={8_037}
        startMs={1_000}
        endMs={6_000}
        maxWindowMs={10_000}
        peaks={null}
        isPlaying={false}
        isBusy={false}
        urlInput=""
        onUrlInputChange={vi.fn()}
        onSubmitUrl={vi.fn()}
        onSelectAudioFile={vi.fn()}
        onChangeRange={onChangeRange}
        onTogglePlay={vi.fn()}
        labels={{ placeholder: "Audio", pickBtn: "Audio", play: "Play", stop: "Stop" }}
      />
    );

    const slider = screen.getByTestId("trim-slider") as HTMLInputElement;
    expect(slider.max).toBe("3037");
    expect(slider.step).toBe("1");
    fireEvent.change(slider, { target: { value: "2500" } });
    expect(onChangeRange).toHaveBeenLastCalledWith(2_500, 7_500);
    fireEvent.change(slider, { target: { value: "3037" } });
    expect(onChangeRange).toHaveBeenLastCalledWith(3_037, 8_037);

    const track = screen.getByTestId("waveform-track");
    Object.defineProperty(track, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40 })
    });
    fireEvent.click(track, { clientX: 100 });
    expect(onChangeRange).toHaveBeenLastCalledWith(1_519, 6_519);
  });

  it("shows localized error banner when an invalid URL is submitted", async () => {
    const provider: SoundProvider = {
      id: "myinstants",
      canResolve: () => false,
      resolve: async () => {
        throw new StikSoundError("url-rejected");
      }
    };

    render(
      <StikSoundMinimalApp
        engine={createTestEngine()}
        providers={[provider]}
        shell={{ saveArtifact: vi.fn() }}
        initialLocale="es"
      />
    );

    const urlInput = screen.getByTestId("myinstants-url-input");
    fireEvent.change(urlInput, { target: { value: "https://evil.example/sound.mp3" } });
    fireEvent.submit(urlInput.closest("form")!);

    await waitFor(() => expect(screen.getByTestId("error-banner").textContent).toContain("MyInstants"));
  });

  it("switches max duration between 5s and 10s, clamps/expands selection, and updates exported filename", async () => {
    const baseEngine = createTestEngine();
    const longEngine = {
      ...baseEngine,
      probeAudio: async (bytes: Uint8Array) => ({
        ...(await baseEngine.probeAudio(bytes)),
        duration_ms: 15_000
      })
    };
    const saved: Array<{ fileName: string }> = [];
    const provider: SoundProvider = {
      id: "myinstants",
      canResolve: () => true,
      resolve: async (url) => ({
        page_url: url,
        media_url: "https://www.myinstants.com/media/sounds/long.mp3",
        title: "Long Clip",
        bytes: new Uint8Array([1, 2, 3, 4])
      })
    };

    render(
      <StikSoundMinimalApp
        engine={longEngine}
        providers={[provider]}
        shell={{
          saveArtifact: async (artifact) => {
            saved.push({ fileName: artifact.fileName });
          }
        }}
        initialLocale="es"
      />
    );

    // Load a valid PNG sticker via file input inside the app shell
    const appShell = screen.getByTestId("stiksound-minimal-app");
    const stickerInput = appShell.querySelector('input[accept*="image/png"]') as HTMLInputElement;
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "ok.png", {
      type: "image/png"
    });
    Object.defineProperty(pngFile, "arrayBuffer", {
      value: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
    });
    fireEvent.change(stickerInput, { target: { files: [pngFile] } });
    await waitFor(() => expect(screen.getByTestId("sticker-loaded-badge")).toBeTruthy());

    // Switch to 5s before importing audio
    fireEvent.click(screen.getByTestId("max-duration-5s"));
    expect(screen.getByTestId("max-duration-5s").getAttribute("aria-pressed")).toBe("true");

    const urlInput = screen.getByTestId("myinstants-url-input");
    fireEvent.change(urlInput, { target: { value: "https://www.myinstants.com/en/instant/test-1/" } });
    fireEvent.submit(urlInput.closest("form")!);

    await waitFor(() => expect(screen.getByTestId("duration-readout").textContent).toBe("5.0s / 5.0s"));

    // The format picker now lives behind the arrow (share) -> "Guardar" on the ready card
    const openFormatPicker = async () => {
      if (!screen.queryByTestId("preview-download-btn")) {
        fireEvent.click(screen.getByTestId("export-ok-btn"));
        await waitFor(() => expect(screen.getByTestId("preview-download-btn")).toBeTruthy());
      }
      fireEvent.click(screen.getByTestId("preview-download-btn"));
      await waitFor(() => expect(screen.getByTestId("download-fmt-video-mp4")).toBeTruthy());
    };

    // Download MP4 at 5s cap
    await openFormatPicker();
    const mp4Choice = screen.getByTestId("download-fmt-video-mp4");
    expect(mp4Choice.textContent ?? "").toMatch(/video mp4/i);
    expect(mp4Choice.textContent ?? "").not.toMatch(/whatsapp/i);
    fireEvent.click(mp4Choice);
    await waitFor(() => {
      expect(saved).toHaveLength(1);
      expect(screen.getByTestId("status-banner").textContent ?? "").toMatch(/no lo importa como sticker/i);
    });
    expect(screen.getByTestId("status-banner").textContent ?? "").not.toMatch(/sticker con audio/i);
    expect(saved[0]!.fileName).toMatch(/-5s\.mp4$/);

    // Switch to 10s -> selection expands automatically to 10.0s
    fireEvent.click(screen.getByTestId("max-duration-10s"));
    await waitFor(() => expect(screen.getByTestId("duration-readout").textContent).toBe("10.0s / 10.0s"));

    // Download MP4 at 10s cap
    await openFormatPicker();
    fireEvent.click(screen.getByTestId("download-fmt-video-mp4"));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]!.fileName).toMatch(/-10s\.mp4$/);

    // Switch back to 5s -> selection clamps back to 5.0s
    fireEvent.click(screen.getByTestId("max-duration-5s"));
    await waitFor(() => expect(screen.getByTestId("duration-readout").textContent).toBe("5.0s / 5.0s"));
  });

  it("renders no copyright notice, redesigned About modal, and switches across all 9 locales including RTL Arabic", () => {
    render(
      <StikSoundMinimalApp
        engine={createTestEngine()}
        providers={[]}
        shell={{ saveArtifact: vi.fn() }}
        initialLocale="es"
        appVersion="1.1.2"
      />
    );

    expect(screen.queryByTestId("copyright-footer")).toBeNull();

    // Open overflow menu and switch language to Chinese, then Arabic (RTL)
    fireEvent.click(screen.getByTestId("overflow-menu-btn"));
    const langSelect = screen.getByTestId("language-select") as HTMLSelectElement;
    expect(langSelect.options).toHaveLength(9);

    fireEvent.change(langSelect, { target: { value: "zh" } });
    expect(screen.getByTestId("stiksound-minimal-app").getAttribute("dir")).toBe("ltr");
    expect(screen.getByTestId("audio-pick-btn").textContent).toBe("音频");

    fireEvent.change(langSelect, { target: { value: "ar" } });
    expect(screen.getByTestId("stiksound-minimal-app").getAttribute("dir")).toBe("rtl");

    fireEvent.change(langSelect, { target: { value: "pt" } });
    expect(screen.getByTestId("audio-pick-btn").textContent).toBe("Áudio");

    // Open About & licenses modal
    fireEvent.click(screen.getByText("Sobre e licenças"));
    const aboutModal = screen.getByTestId("about-modal");
    expect(aboutModal.textContent).toContain("Version 1.1.2");
    expect(aboutModal.textContent).toContain("MIT");
    expect(aboutModal.textContent).toContain("Apache-2.0");
    expect(aboutModal.textContent).not.toContain("Copyright");
    expect(aboutModal.textContent).toContain("symphonia");
    // Fork credits: author + the original project and its copyright holder (required by MIT/Apache-2.0)
    const credits = screen.getByTestId("about-credits");
    expect(credits.textContent).toContain("hweg000");
    expect(credits.textContent).toContain("StikSound");
    expect(credits.textContent).toContain("© 2026 SilverFeit");
    const hrefs = [...credits.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://github.com/hweg000/stickerslive", "https://github.com/SilverFeit/StikSound"]);
  });

  it("sound browser lists MyInstants results and 'Use' imports the picked sound through the providers", async () => {
    const mediaUrl = "https://www.myinstants.com/media/sounds/bruh.mp3";
    const soundSearch = vi.fn(async () => [{ title: "Bruh", media_url: mediaUrl }]);
    const resolve = vi.fn(async (url: string) => ({
      page_url: null,
      media_url: url,
      title: null,
      bytes: new Uint8Array([1, 2, 3, 4])
    }));
    const provider: SoundProvider = { id: "myinstants", canResolve: () => true, resolve };

    render(
      <StikSoundMinimalApp
        engine={createTestEngine()}
        providers={[provider]}
        shell={{ saveArtifact: vi.fn() }}
        initialLocale="es"
        soundSearch={soundSearch}
      />
    );

    fireEvent.click(screen.getByTestId("browse-sounds-btn"));
    expect(screen.getByTestId("sound-browser")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Bruh")).toBeTruthy());
    expect(soundSearch).toHaveBeenCalledWith("", 1);
    // With a sound browser, the separate URL field is gone from the audio bar
    expect(screen.queryByTestId("myinstants-url-input")).toBeNull();

    // A typed search goes to the search; a MyInstants link is not searched
    fireEvent.change(screen.getByTestId("sound-search-input"), { target: { value: "airhorn" } });
    fireEvent.submit(screen.getByTestId("sound-search-input").closest("form")!);
    await waitFor(() => expect(soundSearch).toHaveBeenCalledWith("airhorn", 1));

    fireEvent.click(screen.getByTestId("sound-use-btn"));
    expect(screen.queryByTestId("sound-browser")).toBeNull();
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(mediaUrl));
    await waitFor(() => expect(screen.getByTestId("play-preview-btn")).toBeTruthy());
  });

  it("hides the sound and GIF browser buttons when no sources are given", () => {
    render(<StikSoundMinimalApp engine={createTestEngine()} shell={{ saveArtifact: vi.fn() }} initialLocale="es" />);
    expect(screen.queryByTestId("browse-sounds-btn")).toBeNull();
    expect(screen.queryByTestId("browse-gifs-btn")).toBeNull();
  });

  it("GIF browser: picking a result downloads it and loads it as the sticker (without opening the file picker)", async () => {
    const gif = {
      title: "cat",
      preview_url: "https://media.tenor.com/abcAAAAM/cat.gif",
      gif_url: "https://media.tenor.com/abcAAAAC/cat.gif"
    };
    const gifSource = {
      search: vi.fn(async () => [gif]),
      download: vi.fn(async () => new Uint8Array([0x47, 0x49, 0x46, 0x38]))
    };
    render(
      <StikSoundMinimalApp
        engine={createTestEngine(400, 400, true)}
        shell={{ saveArtifact: vi.fn() }}
        initialLocale="es"
        gifSource={gifSource}
      />
    );
    const fileInput = screen
      .getByTestId("stiksound-minimal-app")
      .querySelector('input[accept*="image/png"]') as HTMLInputElement;
    const pickerClick = vi.spyOn(fileInput, "click");

    // Secondary "upload" opens the file picker; the primary GIF search must not.
    fireEvent.click(screen.getByTestId("upload-sticker-btn"));
    expect(pickerClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("browse-gifs-btn"));
    expect(pickerClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("gif-item")).toBeTruthy());
    expect(gifSource.search).toHaveBeenCalledWith("");

    fireEvent.click(screen.getByTestId("gif-item"));
    expect(screen.queryByTestId("gif-browser")).toBeNull();
    await waitFor(() => expect(gifSource.download).toHaveBeenCalledWith(gif));
    await waitFor(() => expect(screen.getByTestId("sticker-zone").className).toContain("has-sticker"));
  });

  it("framing: zoom slider, reset, and drag-to-pan move the preview exactly like the export crop", async () => {
    // Preview <img> only renders with object URLs; jsdom lacks them.
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    // jsdom has no PointerEvent, so fireEvent.pointer* would drop clientX/pointerId.
    const hadPointerEvent = "PointerEvent" in window;
    if (!hadPointerEvent) {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      }
      (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
    }
    try {
      const gif = { title: "cat", preview_url: "https://media.tenor.com/aAAAAM/c.gif", gif_url: "https://media.tenor.com/aAAAAd/c.gif" };
      render(
        <StikSoundMinimalApp
          engine={createTestEngine(800, 400, true)}
          shell={{ saveArtifact: vi.fn() }}
          initialLocale="es"
          gifSource={{ search: async () => [gif], download: async () => new Uint8Array([0x47, 0x49, 0x46, 0x38]) }}
        />
      );
      fireEvent.click(screen.getByTestId("browse-gifs-btn"));
      await waitFor(() => expect(screen.getByTestId("gif-item")).toBeTruthy());
      fireEvent.click(screen.getByTestId("gif-item"));
      await waitFor(() => expect(screen.getByTestId("zoom-slider")).toBeTruthy());

      const img = () => screen.getByTestId("sticker-zone").querySelector("img") as HTMLImageElement;
      // 800x400 at zoom 1, centred: 400px square -> image is 200% wide, shifted -50%
      expect(img().style.width).toBe("200%");
      expect(img().style.left).toBe("-50%");

      // Zoom 2x (slider is log2): 200px square -> 400% wide
      fireEvent.change(screen.getByTestId("zoom-slider"), { target: { value: "1" } });
      expect(img().style.width).toBe("400%");
      fireEvent.click(screen.getByTestId("crop-reset-btn"));
      expect(img().style.width).toBe("200%");

      // Drag 50px right on a 200px preview box -> 100 source px -> anchor 0.5 -> 0.25 -> left -25%
      const box = screen.getByTestId("sticker-zone").querySelector(".stik-preview-box") as HTMLElement;
      box.getBoundingClientRect = () => ({ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
      const stage = screen.getByTestId("sticker-zone");
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 150, clientY: 100 });
      fireEvent.pointerUp(stage, { pointerId: 1, clientX: 150, clientY: 100 });
      expect(img().style.left).toBe("-25%");

      // Hover without a pressed pointer no longer moves the crop
      fireEvent.pointerMove(stage, { pointerId: 2, clientX: 0, clientY: 0 });
      expect(img().style.left).toBe("-25%");

      // Pinch: fingers 40px apart spread to 80px -> zoom 1 -> 2 -> image 400% wide
      fireEvent.pointerDown(stage, { pointerId: 3, clientX: 100, clientY: 100 });
      fireEvent.pointerDown(stage, { pointerId: 4, clientX: 140, clientY: 100 });
      fireEvent.pointerMove(stage, { pointerId: 4, clientX: 180, clientY: 100 });
      fireEvent.pointerUp(stage, { pointerId: 4 });
      fireEvent.pointerUp(stage, { pointerId: 3 });
      expect(img().style.width).toBe("400%");
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      if (!hadPointerEvent) delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
    }
  });
});

describe("microphone recording", () => {
  it("Record -> Stop imports the take as audio (WAV) and shows the recording timer", async () => {
    render(<StikSoundMinimalApp engine={createTestEngine()} shell={{ saveArtifact: vi.fn() }} initialLocale="es" />);
    const btn = () => screen.getByTestId("record-audio-btn");
    expect(btn().textContent).toContain("Grabar");

    fireEvent.click(btn());
    await waitFor(() => expect(btn().textContent).toContain("Detener"));
    expect(btn().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(btn());
    await waitFor(() => expect(recordingMock.stop).toHaveBeenCalled());
    // Imported through the normal audio path -> the trim bar switches to the active player
    await waitFor(() => expect(screen.getByTestId("play-preview-btn")).toBeTruthy());
  });
});

describe("sound browser links", () => {
  it("pasting a MyInstants link in the sound search imports it directly", async () => {
    const link = "https://www.myinstants.com/es/instant/bruh-1234/";
    const soundSearch = vi.fn(async () => []);
    const resolve = vi.fn(async (url: string) => ({ page_url: url, media_url: url, title: null, bytes: new Uint8Array([1, 2, 3, 4]) }));
    render(
      <StikSoundMinimalApp
        engine={createTestEngine()}
        providers={[{ id: "myinstants", canResolve: () => true, resolve }]}
        shell={{ saveArtifact: vi.fn() }}
        initialLocale="es"
        soundSearch={soundSearch}
      />
    );
    fireEvent.click(screen.getByTestId("browse-sounds-btn"));
    fireEvent.paste(screen.getByTestId("sound-search-input"), { clipboardData: { getData: () => link } });
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(link));
    expect(soundSearch).not.toHaveBeenCalledWith(link, 1);
    await waitFor(() => expect(screen.queryByTestId("sound-browser")).toBeNull());
  });
});

describe("change sound", () => {
  it("'Cambiar sonido' reopens the sources, Cancel returns, and a new sound replaces the old one", async () => {
    const urls: string[] = [];
    const resolve = vi.fn(async (url: string) => {
      urls.push(url);
      return { page_url: null, media_url: url, title: null, bytes: new Uint8Array([1, 2, 3, 4]) };
    });
    const soundSearch = vi.fn(async () => [{ title: "Bruh", media_url: "https://www.myinstants.com/media/sounds/bruh.mp3" }]);
    render(
      <StikSoundMinimalApp
        engine={createTestEngine()}
        providers={[{ id: "myinstants", canResolve: () => true, resolve }]}
        shell={{ saveArtifact: vi.fn() }}
        initialLocale="es"
        soundSearch={soundSearch}
      />
    );
    const pick = async () => {
      fireEvent.click(screen.getByTestId("browse-sounds-btn"));
      await waitFor(() => expect(screen.getByTestId("sound-use-btn")).toBeTruthy());
      fireEvent.click(screen.getByTestId("sound-use-btn"));
      await waitFor(() => expect(screen.getByTestId("play-preview-btn")).toBeTruthy());
    };
    await pick();

    // Change -> sources come back (with Cancel); Cancel -> the player returns, sound untouched
    fireEvent.click(screen.getByTestId("change-audio-btn"));
    expect(screen.queryByTestId("play-preview-btn")).toBeNull();
    expect(screen.getByTestId("browse-sounds-btn")).toBeTruthy();
    fireEvent.click(screen.getByTestId("cancel-change-audio-btn"));
    expect(screen.getByTestId("play-preview-btn")).toBeTruthy();
    expect(resolve).toHaveBeenCalledTimes(1);

    // Change -> pick another -> back to the player, no Cancel left behind
    fireEvent.click(screen.getByTestId("change-audio-btn"));
    await pick();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("cancel-change-audio-btn")).toBeNull();
  });
});

describe("how-to tour", () => {
  it("shows on first visit, walks 4 steps, is remembered, and reopens from the menu", () => {
    localStorage.removeItem("sticksound.tourSeen");
    const app = () => (
      <StikSoundMinimalApp engine={createTestEngine()} shell={{ saveArtifact: vi.fn() }} initialLocale="es" showTourOnFirstVisit />
    );
    const { unmount } = render(app());
    expect(screen.getByTestId("tour").textContent).toContain("1/4");
    expect(screen.getByTestId("tour-text").textContent).toContain("Buscar GIF");
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId("tour-next"));
    expect(screen.getByTestId("tour").textContent).toContain("4/4");
    expect(screen.getByTestId("tour-next").textContent).toBe("¡Listo!");
    fireEvent.click(screen.getByTestId("tour-next"));
    expect(screen.queryByTestId("tour")).toBeNull();
    unmount();

    // Second visit: remembered, not shown; reachable from the header "?" button
    render(app());
    expect(screen.queryByTestId("tour")).toBeNull();
    expect(screen.getByTestId("help-tour-btn").getAttribute("aria-label")).toBe("Cómo usar");
    fireEvent.click(screen.getByTestId("help-tour-btn"));
    expect(screen.getByTestId("tour").textContent).toContain("1/4");
    localStorage.removeItem("sticksound.tourSeen");
  });
});

describe("WhatsApp sticker guide", () => {
  it("opens from the header button, walks 6 steps and links the Android beta opt-in", () => {
    render(<StikSoundMinimalApp engine={createTestEngine()} shell={{ saveArtifact: vi.fn() }} initialLocale="es" />);
    // Help is no longer hidden in the ⋯ menu
    fireEvent.click(screen.getByTestId("overflow-menu-btn"));
    expect(screen.getByTestId("overflow-menu").textContent).not.toMatch(/Cómo usar|WhatsApp/);
    fireEvent.click(screen.getByTestId("help-whatsapp-btn"));
    expect(screen.getByTestId("tour").textContent).toContain("Sticker en WhatsApp · 1/6");

    fireEvent.click(screen.getByTestId("tour-next"));
    expect(screen.getByTestId("tour-text").textContent).toContain("Únete a la beta");
    expect(screen.getByTestId("tour-link").getAttribute("href")).toBe("https://play.google.com/apps/testing/com.whatsapp");
    expect(screen.getByTestId("tour-link").getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("tour-image").getAttribute("alt")).toContain("Become a tester");

    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByTestId("tour-next"));
    expect(screen.getByTestId("tour").textContent).toContain("6/6");
    expect(screen.getByTestId("tour-text").textContent).toContain("Crear sticker");
    fireEvent.click(screen.getByTestId("tour-next"));
    expect(screen.queryByTestId("tour")).toBeNull();
  });
});
