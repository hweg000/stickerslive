import { describe, expect, it } from "vitest";
import {
  ERROR_CATALOG,
  ProjectController,
  SUPPORTED_LOCALES,
  StikSoundError,
  computeSquareCrop,
  createProject,
  defaultTrimForDuration,
  detectLocale,
  resetProject,
  sanitizeExportName,
  slideTrimWindow,
  validateProjectManifest,
  type MediaEngine,
  type ZipEntryInput
} from "../src/index";

function makeFakeEngine(overrides: Partial<MediaEngine> = {}): MediaEngine {
  return {
    async probeImage(bytes) {
      if (bytes[0] === 0x00) throw new StikSoundError("unsupported-image", "Corrupt image");
      const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
      return {
        format: isGif ? "gif" : "png",
        width: 512,
        height: 512,
        has_alpha: true,
        animated: isGif,
        frame_count: isGif ? 10 : 1,
        duration_ms: isGif ? 2000 : 0
      };
    },
    async renderSticker() {
      return { width: 512, height: 512, data: new Uint8Array(512 * 512 * 4) };
    },
    async encodeWebp() {
      return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    },
    async probeAudio(bytes) {
      if (bytes[0] === 0xff && bytes[1] === 0x00) {
        throw new StikSoundError("unsupported-audio", "Not valid audio");
      }
      const durationMs = bytes.byteLength === 4 ? 30_000 : bytes.byteLength === 5 ? 10_000 : 2500;
      return { format: "mp3", duration_ms: durationMs, sample_rate: 44100, channels: 2 };
    },
    async waveform() {
      return {
        buckets: 1024,
        mins: new Float32Array(1024).fill(-0.5),
        maxs: new Float32Array(1024).fill(0.5)
      };
    },
    async renderAudio(_bytes, edit) {
      const durationMs = edit.end_ms - edit.start_ms;
      return {
        sampleRate: 48000,
        channels: 1,
        samples: new Float32Array(Math.round((durationMs / 1000) * 48000)),
        durationMs
      };
    },
    async encodeOpus() {
      return new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    },
    async renderVideo(req) {
      return {
        bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
        mimeType: req.container === "webm-alpha" ? "video/webm" : "video/mp4",
        extension: req.container === "webm-alpha" ? "webm" : "mp4",
        durationMs: Math.max(req.endMs - req.startMs, req.minDurationMs ?? 0),
        hasAlpha: req.container === "webm-alpha"
      };
    },
    async zip(entries) {
      return new TextEncoder().encode(
        JSON.stringify(entries.map((e) => ({ path: e.path, b64: Buffer.from(e.bytes).toString("base64") })))
      );
    },
    async unzip(zipBytes) {
      const list = JSON.parse(new TextDecoder().decode(zipBytes)) as Array<{ path: string; b64: string }>;
      return list.map((item): ZipEntryInput => ({
        path: item.path,
        bytes: new Uint8Array(Buffer.from(item.b64, "base64"))
      }));
    },
    ...overrides
  };
}

describe("packages/core domain and use cases", () => {
  it("frames default audio trim to max 10000 ms and slides window cleanly", () => {
    expect(defaultTrimForDuration(30_000)).toEqual({
      start_ms: 0,
      end_ms: 10_000,
      volume: 1,
      fade_in_ms: 0,
      fade_out_ms: 0
    });
    expect(defaultTrimForDuration(2300)).toEqual({
      start_ms: 0,
      end_ms: 2300,
      volume: 1,
      fade_in_ms: 0,
      fade_out_ms: 0
    });
    expect(slideTrimWindow(25_000, 10_000, 30_000)).toEqual({
      start_ms: 20_000,
      end_ms: 30_000
    });
  });

  it("TC-015 & reset: replaces audio resetting trim, keeps audio when replacing sticker, and resets all on X", async () => {
    const ctrl = new ProjectController(makeFakeEngine());
    let project = createProject("CatMeme");
    project = await ctrl.importSticker(project, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "cat.png");
    project = await ctrl.importAudioFile(project, new Uint8Array([1, 2, 3, 4]), "long.mp3");
    project = ctrl.updateAudioEdit(project, { start_ms: 1000, end_ms: 4500 });

    const audioIdBefore = project.manifest.audios[0]!.id;
    project = await ctrl.importSticker(project, new Uint8Array([0x47, 0x49, 0x46, 0x38]), "cat2.gif");
    expect(project.manifest.audios[0]!.id).toBe(audioIdBefore);
    expect(project.manifest.associations[0]!.start_ms).toBe(1000);
    expect(project.manifest.stickers[0]!.format).toBe("gif");

    project = await ctrl.importAudioFile(project, new Uint8Array([1, 2]), "short.mp3");
    expect(project.manifest.associations[0]!.start_ms).toBe(0);
    expect(project.manifest.associations[0]!.end_ms).toBe(2500);

    const cleared = resetProject(project);
    expect(cleared.manifest.stickers).toHaveLength(0);
    expect(cleared.manifest.audios).toHaveLength(0);
    expect(cleared.manifest.associations).toHaveLength(0);
  });

  it("TC-006: rejects corrupt media without overwriting valid assets", async () => {
    const ctrl = new ProjectController(makeFakeEngine());
    let project = createProject("Safe");
    project = await ctrl.importSticker(project, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "ok.png");

    await expect(ctrl.importSticker(project, new Uint8Array([0x00, 0x01]), "bad.png")).rejects.toThrowError(
      StikSoundError
    );
    expect(project.manifest.stickers).toHaveLength(1);
    expect(project.manifest.stickers[0]!.source_name).toBe("ok.png");
  });

  it("TC-014: accepts 10000 ms selections and rejects longer ranges", async () => {
    const ctrl = new ProjectController(makeFakeEngine());
    let project = createProject("TrimTest");
    project = await ctrl.importSticker(project, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "ok.png");
    project = await ctrl.importAudioFile(project, new Uint8Array([1, 2, 3, 4]), "30s.mp3");

    expect(() => ctrl.updateAudioEdit(project, { start_ms: 0, end_ms: 10_000 })).not.toThrow();
    expect(() => ctrl.updateAudioEdit(project, { start_ms: 0, end_ms: 10_001 })).toThrowError(
      /trim-out-of-range/
    );
  });

  it("imports an exact 10-second audio without forcing a shorter trim", async () => {
    const ctrl = new ProjectController(makeFakeEngine());
    let project = createProject("TenSeconds");
    project = await ctrl.importSticker(project, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "ok.png");
    project = await ctrl.importAudioFile(project, new Uint8Array([1, 2, 3, 4, 5]), "10s.mp3");

    expect(project.manifest.audios[0]!.duration_ms).toBe(10_000);
    expect(project.manifest.associations[0]!.start_ms).toBe(0);
    expect(project.manifest.associations[0]!.end_ms).toBe(10_000);
  });

  it("exports video-mp4 by default, supports sound-bundle (TC-008), and blocks native-sound-sticker", async () => {
    const engine = makeFakeEngine();
    const ctrl = new ProjectController(engine);
    let project = createProject("My Sound!");
    project = await ctrl.importSticker(project, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "ok.png");
    project = await ctrl.importAudioFile(project, new Uint8Array([1, 2, 3, 4]), "30s.mp3");

    const mp4 = await ctrl.exportProject(project);
    expect(mp4.profile).toBe("video-mp4");
    expect(mp4.fileName).toBe("my-sound-10s.mp4");
    expect(mp4.durationMs).toBe(10_000);

    const bundle = await ctrl.exportProject(project, "sound-bundle");
    expect(bundle.fileName).toBe("my-sound-stiksound.zip");
    const entries = await engine.unzip(bundle.bytes);
    expect(entries.map((e) => e.path).sort()).toEqual(["manifest.json", "sound.ogg", "sticker.webp"]);
    const bundleManifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === "manifest.json")!.bytes));
    expect(bundleManifest.bundle.whatsapp_native).toBe(false);
    expect(() => validateProjectManifest(bundleManifest)).not.toThrow();

    const nativeError = await ctrl.exportProject(project, "native-sound-sticker").catch((err: unknown) => err);
    expect(nativeError).toBeInstanceOf(StikSoundError);
    if (!(nativeError instanceof StikSoundError)) return;
    expect(nativeError.code).toBe("export-unsupported");
    expect(nativeError.getLocalized("es").action).not.toMatch(/sticker con audio/i);
    expect(nativeError.getLocalized("en").action).not.toMatch(/sound sticker/i);
    expect(nativeError.getLocalized("es").action.toLowerCase()).toContain("video");
    expect(nativeError.getLocalized("en").action.toLowerCase()).toContain("video");
  });

  it("TC-009, SEC-008 & SEC-010: saves/reopens project and blocks path traversal", async () => {
    const ctrl = new ProjectController(makeFakeEngine());
    let project = createProject("../../escape");
    expect(sanitizeExportName(project.manifest.project.name)).toBe("escape");
    expect(sanitizeExportName("..//..")).toBe("stiksound");

    project = await ctrl.importSticker(project, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "ok.png");
    project = await ctrl.importAudioFile(project, new Uint8Array([1, 2, 3, 4]), "30s.mp3");
    const savedZip = await ctrl.saveProject(project);
    const reopened = await ctrl.openProject(savedZip);
    expect(reopened.manifest.associations[0]!.end_ms).toBe(10_000);

    const badManifest = structuredClone(project.manifest);
    badManifest.stickers[0]!.file = "assets/../etc/passwd";
    expect(() => validateProjectManifest(badManifest)).toThrowError(/package-invalid/);

    // Crop zoom (edit.scale) from a package must stay in range
    const zoomed = structuredClone(project.manifest);
    zoomed.stickers[0]!.edit.scale = 2.5;
    expect(() => validateProjectManifest(zoomed)).not.toThrow();
    zoomed.stickers[0]!.edit.scale = 9;
    expect(() => validateProjectManifest(zoomed)).toThrowError(/package-invalid/);
  });

  it("square crop zoom: in = smaller movable square, out = margins (negative src), same output size", () => {
    // Zoom in 2x on 400x200: 100px square, travels the full width and height
    expect(computeSquareCrop(400, 200, 0, 0, 2)).toEqual({ srcX: 0, srcY: 0, cropSide: 100, outputSize: 200 });
    expect(computeSquareCrop(400, 200, 1, 1, 2)).toEqual({ srcX: 300, srcY: 100, cropSide: 100, outputSize: 200 });
    // Zoom out to "contain": 400px square, the 200px-high image is centered with 100px margins
    expect(computeSquareCrop(400, 200, 0.5, 0.5, 0.5)).toEqual({ srcX: 0, srcY: -100, cropSide: 400, outputSize: 200 });
    // Out-of-range zoom is clamped to [0.25, 4]; zoom 1 keeps the old behaviour
    expect(computeSquareCrop(400, 400, 0.5, 0.5, 100).cropSide).toBe(100);
    expect(computeSquareCrop(400, 400, 0.5, 0.5, 0.01).cropSide).toBe(1600);
    expect(computeSquareCrop(1000, 500, 1, 0.5, 1)).toEqual(computeSquareCrop(1000, 500, 1, 0.5));
  });

  it("computes 1:1 square crop from center by default and respects input-driven resolution <= 512", () => {
    // 1000x500 wide image -> cropSide 500, outputSize 500, centered srcX = 250
    expect(computeSquareCrop(1000, 500)).toEqual({
      srcX: 250,
      srcY: 0,
      cropSide: 500,
      outputSize: 500
    });
    // Mouse hover panned to right edge (cropX = 1)
    expect(computeSquareCrop(1000, 500, 1, 0.5)).toEqual({
      srcX: 500,
      srcY: 0,
      cropSide: 500,
      outputSize: 500
    });
    // Smaller 192x192 input stays 192x192 (never upscaled)
    expect(computeSquareCrop(192, 192)).toEqual({
      srcX: 0,
      srcY: 0,
      cropSide: 192,
      outputSize: 192
    });
    // Large 1920x1080 caps at 512x512
    expect(computeSquareCrop(1920, 1080, 0.5, 0.5)).toEqual({
      srcX: 420,
      srcY: 0,
      cropSide: 1080,
      outputSize: 512
    });
  });

  it("supports configurable 5s and 10s max audio caps across import, edit, and export", async () => {
    const ctrl = new ProjectController(makeFakeEngine());
    let project = createProject("SwitchCap");
    project = await ctrl.importSticker(project, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "ok.png");
    project = await ctrl.importAudioFile(project, new Uint8Array([1, 2, 3, 4]), "30s.mp3", { type: "local" }, 5_000);

    expect(project.manifest.associations[0]!.start_ms).toBe(0);
    expect(project.manifest.associations[0]!.end_ms).toBe(5_000);
    expect(() => ctrl.updateAudioEdit(project, { start_ms: 0, end_ms: 5_001 }, 5_000)).toThrowError(
      /trim-out-of-range/
    );

    const mp4Five = await ctrl.exportProject(project, "video-mp4", 5_000);
    expect(mp4Five.fileName).toBe("switchcap-5s.mp4");
    expect(mp4Five.durationMs).toBe(5_000);

    project = ctrl.updateAudioEdit(project, { start_ms: 0, end_ms: 10_000 }, 10_000);
    const mp4Ten = await ctrl.exportProject(project, "video-mp4", 10_000);
    expect(mp4Ten.fileName).toBe("switchcap-10s.mp4");
    expect(mp4Ten.durationMs).toBe(10_000);
  });

  it("enforces animated GIF minimum duration while keeping short 1.5s audio length when >= GIF loop", async () => {
    const engine = makeFakeEngine({
      async probeImage(bytes) {
        const isShortGif = bytes[3] === 0x39;
        return {
          format: "gif",
          width: 498,
          height: 498,
          has_alpha: true,
          animated: true,
          frame_count: 11,
          duration_ms: isShortGif ? 550 : 2_000
        };
      },
      async probeAudio(bytes) {
        const durationMs = bytes.byteLength === 3 ? 1_500 : bytes.byteLength === 2 ? 800 : 10_000;
        return { format: "mp3", duration_ms: durationMs, sample_rate: 44100, channels: 2 };
      }
    });
    const ctrl = new ProjectController(engine);

    // Case 1: 550ms GIF + 1500ms audio -> exports at 1500ms
    let proj = createProject("ShortGif");
    proj = await ctrl.importSticker(proj, new Uint8Array([0x47, 0x49, 0x46, 0x39]), "short.gif");
    proj = await ctrl.importAudioFile(proj, new Uint8Array([1, 2, 3]), "1500ms.mp3");
    const mp4Short = await ctrl.exportProject(proj, "video-mp4", 5_000);
    expect(mp4Short.durationMs).toBe(1_500);

    // Case 2: 2000ms GIF + 10000ms audio -> trimming below 2000ms throws trim-out-of-range
    proj = await ctrl.importSticker(proj, new Uint8Array([0x47, 0x49, 0x46, 0x38]), "long.gif");
    proj = await ctrl.importAudioFile(proj, new Uint8Array([1, 2, 3, 4]), "10000ms.mp3");
    expect(() => ctrl.updateAudioEdit(proj, { start_ms: 0, end_ms: 1_500 }, 5_000)).toThrowError(
      /trim-out-of-range/
    );

    // Case 3: 2000ms GIF + 800ms audio -> exports 2000ms video (minDurationMs = 2000)
    proj = await ctrl.importAudioFile(proj, new Uint8Array([1, 2]), "800ms.mp3");
    const mp4MinGif = await ctrl.exportProject(proj, "video-mp4", 5_000);
    expect(mp4MinGif.durationMs).toBe(2_000);
  });

  it("detects all 9 supported locales and provides localized errors for each", () => {
    expect(SUPPORTED_LOCALES).toEqual(["es", "en", "pt", "fr", "de", "it", "ru", "zh", "ar"]);
    expect(detectLocale("es-CO")).toBe("es");
    expect(detectLocale("pt-BR")).toBe("pt");
    expect(detectLocale("zh-CN")).toBe("zh");
    expect(detectLocale("ar-SA")).toBe("ar");
    expect(detectLocale("fr-FR")).toBe("fr");
    expect(detectLocale("de-DE")).toBe("de");
    expect(detectLocale("it-IT")).toBe("it");
    expect(detectLocale("ru-RU")).toBe("ru");
    expect(detectLocale("ja-JP")).toBe("en");
    expect(detectLocale(undefined)).toBe("en");

    const err = new StikSoundError("unsupported-image");
    for (const loc of SUPPORTED_LOCALES) {
      for (const code of Object.keys(ERROR_CATALOG) as Array<keyof typeof ERROR_CATALOG>) {
        expect(ERROR_CATALOG[code][loc].title.length).toBeGreaterThan(0);
        expect(ERROR_CATALOG[code][loc].action.length).toBeGreaterThan(0);
      }
      expect(err.getLocalized(loc).title.length).toBeGreaterThan(0);
    }
  });
});
