import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  WebMediaEngine,
  compositeRgbaOnMatte,
  cropAndFitSquareRgba,
  decodeGifFramesRgba,
  encodeWavBytes,
  extractRawAudioSpecificConfig,
  prepareAnimatedGifFrames,
  sanitizeMp4AudioChunkMeta,
  gifFrameDelayMs,
  resampleGifScheduleForEncoder,
  scheduleGifFramesForDuration,
  sniffImageHeader,
  trimPcmSamples
} from "../src/index";

function makeMinimalPngHeader(w: number, h: number, colorType = 6): Uint8Array {
  const buf = new Uint8Array(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(buf.buffer);
  view.setUint32(8, 13, false);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, w, false);
  view.setUint32(20, h, false);
  buf[24] = 8;
  buf[25] = colorType;
  return buf;
}

function makeAnimatedGifBytes(): Uint8Array {
  // GIF89a 2x2 with 2 frames, GCT [red, green, blue, transparent], LZW minCodeSize=2,
  // Frame 1 (20cs = 200ms) draws color index 0 (red), Frame 2 (30cs = 300ms) draws color index 1 (green)
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x02, 0x00, 0x02, 0x00, 0x91, 0x00, 0x00, // 2x2, GCT 4 colors (2^(1+1)=4)
    0xff, 0x00, 0x00, // 0: red
    0x00, 0xff, 0x00, // 1: green
    0x00, 0x00, 0xff, // 2: blue
    0x00, 0x00, 0x00, // 3: transparent placeholder
    // Frame 1 GCE: disposal=0, transparent=true, index=3, delay=20cs (200ms)
    0x21, 0xf9, 0x04, 0x01, 0x14, 0x00, 0x03, 0x00,
    // Image descriptor 1 + LZW min=2: clear(4),0,0,0,0,eoi(5) -> 3-bit codes: 100,000,000,000,000,101 = [0x04, 0x80, 0x02]
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x02, 0x03, 0x04, 0x80, 0x02, 0x00,
    // Frame 2 GCE: disposal=0, transparent=true, index=3, delay=30cs (300ms)
    0x21, 0xf9, 0x04, 0x01, 0x1e, 0x00, 0x03, 0x00,
    // Image descriptor 2 (1x1 overlay at (0,0) with index 1 = green, leaving rest red from frame 1):
    // LZW min=2: clear(4),1,eoi(5) -> 3-bit codes: 100,001,101 -> bits: 00001100=0x0c, 0x05? let's encode cleanly:
    // LSB-first: code0=4(100), code1=1(001)-> bits 0..2=100, 3..5=001, 6..7=10 -> byte0 = 0b10_001_100 = 0x8c, bit8=1 -> byte1 = 0x01
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x8c, 0x01, 0x00,
    0x3b
  ]);
}

describe("packages/media-web", () => {
  it("sniffs PNG alpha, animated GIF frames, and rejects 40MP decompression bombs (SEC-009)", () => {
    const png = sniffImageHeader(makeMinimalPngHeader(400, 300, 6));
    expect(png).toEqual({
      format: "png",
      width: 400,
      height: 300,
      has_alpha: true,
      animated: false,
      frame_count: 1,
      duration_ms: 0
    });

    const gif = sniffImageHeader(makeAnimatedGifBytes());
    expect(gif.format).toBe("gif");
    expect(gif.animated).toBe(true);
    expect(gif.has_alpha).toBe(true);
    expect(gif.frame_count).toBe(2);
    expect(gif.duration_ms).toBe(500);

    expect(() => sniffImageHeader(makeMinimalPngHeader(9000, 9000, 6))).toThrowError(/file-too-large/);
  });

  it("decodes animated GIF frames with distinct RGBA content and compositing (Issue #3)", () => {
    const gifBytes = makeAnimatedGifBytes();
    const decoded = decodeGifFramesRgba(gifBytes);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.delayMs).toBe(200);
    expect(decoded[1]!.delayMs).toBe(300);

    // Frame 1 pixel (0,0) is red [255, 0, 0, 255]
    expect(Array.from(decoded[0]!.rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);
    // Frame 2 pixel (0,0) is green [0, 255, 0, 255], while pixel (1,0) retains red from Frame 1
    expect(Array.from(decoded[1]!.rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
    expect(Array.from(decoded[1]!.rgba.slice(4, 8))).toEqual([255, 0, 0, 255]);

    const prepared = prepareAnimatedGifFrames({
      stickerBytes: gifBytes,
      cropX: 0.5,
      cropY: 0.5,
      container: "mp4",
      matteColor: "#FFFFFF"
    });
    expect(prepared).toHaveLength(2);
    expect(Array.from(prepared[0]!.rgba.slice(0, 4))).not.toEqual(Array.from(prepared[1]!.rgba.slice(0, 4)));

    const schedule = scheduleGifFramesForDuration(
      prepared.map((f, frameIndex) => ({ frameIndex, delayMs: f.delayMs })),
      1_000
    );
    expect(schedule.some((s) => s.frameIndex === 0)).toBe(true);
    expect(schedule.some((s) => s.frameIndex === 1)).toBe(true);
  });

  it("preserves alpha during 1:1 input-driven crop and cleanly composites onto matte", () => {
    const src = new Uint8Array(8 * 4 * 4);
    // Left half (x 0..3) red, right half (x 4..7) transparent
    for (let y = 1; y <= 2; y++) {
      for (let x = 1; x <= 2; x++) {
        const i = (y * 8 + x) * 4;
        src[i] = 255;
        src[i + 3] = 255;
      }
    }
    // cropX = 0 picks the left 4x4 square -> output is 4x4 (never upscaled)
    const leftSquare = cropAndFitSquareRgba(src, 8, 4, 0, 0.5);
    expect(leftSquare.width).toBe(4);
    expect(leftSquare.height).toBe(4);
    expect(leftSquare.data[3]).toBe(0); // corner transparent
    const centerIdx = (1 * 4 + 1) * 4;
    expect(leftSquare.data[centerIdx]).toBe(255);
    expect(leftSquare.data[centerIdx + 3]).toBe(255);

    const matted = compositeRgbaOnMatte(leftSquare, "#FFFFFF");
    expect(matted[0]).toBe(255);
    expect(matted[1]).toBe(255);
    expect(matted[2]).toBe(255);
    expect(matted[3]).toBe(255);
  });

  it("zoomed-out crop leaves transparent margins instead of stretching edge pixels", () => {
    // Fully opaque 8x4 image, zoom 0.5 -> 8x8 square (image centred, 2px margins), output 4x4
    const src2 = new Uint8Array(8 * 4 * 4).fill(255);
    const out2 = cropAndFitSquareRgba(src2, 8, 4, 0.5, 0.5, 0.5);
    expect(out2.width).toBe(4);
    const alphaAtRow = (row: number) => out2.data[(row * 4 + 1) * 4 + 3];
    expect(alphaAtRow(0)).toBe(0); // top margin
    expect(alphaAtRow(1)).toBe(255); // image
    expect(alphaAtRow(2)).toBe(255);
    expect(alphaAtRow(3)).toBe(0); // bottom margin
  });

  it("schedules looping GIF frames across exact 10-second video duration", () => {
    const schedule = scheduleGifFramesForDuration(
      [
        { frameIndex: 0, delayMs: 500 },
        { frameIndex: 1, delayMs: 500 }
      ],
      10_000
    );
    expect(schedule).toHaveLength(20);
    const totalUs = schedule.reduce((sum, s) => sum + s.durationUs, 0);
    expect(totalUs).toBe(10_000_000);
  });

  it("normalizes GIF frame delays the way browsers play them in the preview", () => {
    expect(gifFrameDelayMs(null)).toBe(100);
    expect(gifFrameDelayMs(0)).toBe(100);
    expect(gifFrameDelayMs(10)).toBe(100);
    expect(gifFrameDelayMs(19.9)).toBe(100);
    expect(gifFrameDelayMs(20)).toBe(20);
    expect(gifFrameDelayMs(66.6)).toBe(67);
  });

  it("decodes 0 and 1 centisecond GIF delays as 100 ms (issue #3)", () => {
    const gif = makeGif(1, 1, [
      { width: 1, height: 1, data: D0, gce: { delayCs: 0 } },
      { width: 1, height: 1, data: D0, gce: { delayCs: 1 } },
      { width: 1, height: 1, data: D0, gce: { delayCs: 2 } }
    ]);
    expect(decodeGifFramesRgba(gif).map((f) => f.delayMs)).toEqual([100, 100, 20]);
  });

  it("resamples GIF frames to 24 fps with a keyframe at every new GIF frame (issue #3)", () => {
    const schedule = scheduleGifFramesForDuration(
      [
        { frameIndex: 0, delayMs: 100 },
        { frameIndex: 1, delayMs: 200 },
        { frameIndex: 2, delayMs: 100 }
      ],
      2_000
    );
    const encoded = resampleGifScheduleForEncoder(schedule, 2_000);

    expect(encoded).toHaveLength(48);
    expect(encoded[0]).toMatchObject({ frameIndex: 0, timestampUs: 0, keyFrame: true });
    const totalUs = encoded.reduce((sum, f) => sum + f.durationUs, 0);
    expect(totalUs).toBe(2_000_000);
    for (let i = 1; i < encoded.length; i++) {
      expect(encoded[i]!.timestampUs).toBe(encoded[i - 1]!.timestampUs + encoded[i - 1]!.durationUs);
      if (encoded[i]!.frameIndex !== encoded[i - 1]!.frameIndex) {
        expect(encoded[i]!.keyFrame).toBe(true);
      }
    }
    // All three GIF frames appear, and the animation loops (frame 0 returns).
    const order = encoded.map((f) => f.frameIndex).filter((v, i, a) => i === 0 || v !== a[i - 1]);
    expect(order.slice(0, 4)).toEqual([0, 1, 2, 0]);
  });

  it("trims WAV audio within 50 ms tolerance and rejects Zip-Slip (SEC-006)", async () => {
    const samples = new Float32Array(48000 * 12).fill(0.25);
    const wav = encodeWavBytes({ sampleRate: 48000, channels: 1, samples, durationMs: 12_000 });
    const engine = new WebMediaEngine();

    const probe = await engine.probeAudio(wav);
    expect(probe.format).toBe("wav");
    expect(probe.duration_ms).toBe(12_000);

    const peaks = await engine.waveform(wav);
    expect(peaks.buckets).toBe(1024);

    const trimmed = trimPcmSamples(samples, 48000, 1000, 11_000, 1);
    expect(Math.abs(trimmed.durationMs - 10_000)).toBeLessThanOrEqual(50);
    expect(() => trimPcmSamples(samples, 48000, 1000, 11_001, 1)).toThrowError(/trim-out-of-range/);

    const evilZip = zipSync({ "../outside.txt": new Uint8Array([1, 2, 3]) });
    await expect(engine.unzip(evilZip)).rejects.toMatchObject({ code: "package-invalid" });
  });

  it("extracts raw AudioSpecificConfig from Apple ES_Descriptor without double-wrapping MP4 esds", () => {
    const appleEsDescriptor = Uint8Array.from(
      Buffer.from("038080802200000004808080144014001800000000000000000005808080021188068080800102", "hex")
    );
    const extracted = extractRawAudioSpecificConfig(appleEsDescriptor);
    expect(Array.from(extracted ?? [])).toEqual([0x11, 0x88]);

    const rawAsc = new Uint8Array([0x11, 0x88]);
    expect(Array.from(extractRawAudioSpecificConfig(rawAsc) ?? [])).toEqual([0x11, 0x88]);

    const sanitized = sanitizeMp4AudioChunkMeta({
      decoderConfig: {
        codec: "mp4a.40.2",
        sampleRate: 48000,
        numberOfChannels: 1,
        description: appleEsDescriptor
      }
    });
    expect(Array.from(new Uint8Array(sanitized?.decoderConfig?.description as ArrayBuffer))).toEqual([0x11, 0x88]);
  });

  it("TC-018: reports unsupported-codec when WebCodecs is absent without writing files", async () => {
    const engine = new WebMediaEngine();
    await expect(
      engine.renderVideo({
        stickerBytes: makeMinimalPngHeader(64, 64),
        stickerFormat: "png",
        animated: false,
        audioBytes: new Uint8Array(100),
        audioFormat: "wav",
        startMs: 0,
        endMs: 3000,
        volume: 1,
        matteColor: "#FFFFFF",
        container: "mp4"
      })
    ).rejects.toMatchObject({ code: "unsupported-codec" });
  });
});

function makeGif(width: number, height: number, frames: Array<{
  left?: number;
  top?: number;
  width: number;
  height: number;
  data: number[];
  minCodeSize?: number;
  gce?: { disposal?: number; delayCs?: number; transparentIndex?: number };
}>): Uint8Array {
  const bytes: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff, 0x91, 0x00, 0x00];
  bytes.push(0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00);
  for (const frame of frames) {
    if (frame.gce) {
      const disposal = frame.gce.disposal ?? 0;
      const delayCs = frame.gce.delayCs ?? 10;
      const transparentIndex = frame.gce.transparentIndex;
      const packed = ((disposal & 0x07) << 2) | (transparentIndex !== undefined ? 0x01 : 0x00);
      bytes.push(0x21, 0xf9, 0x04, packed, delayCs & 0xff, (delayCs >> 8) & 0xff, transparentIndex ?? 0, 0x00);
    }
    const left = frame.left ?? 0;
    const top = frame.top ?? 0;
    const minCodeSize = frame.minCodeSize ?? 2;
    bytes.push(0x2c, left & 0xff, (left >> 8) & 0xff, top & 0xff, (top >> 8) & 0xff, frame.width & 0xff, (frame.width >> 8) & 0xff, frame.height & 0xff, (frame.height >> 8) & 0xff, 0x00, minCodeSize, frame.data.length, ...frame.data, 0x00);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

const D0 = [0x04, 0x80, 0x02];
const D1 = [0x8c, 0x01];
const D2 = [0x54, 0x01];

describe("packages/media-web gif resource limits", () => {
  it("rejects a GIF whose frame descriptor claims excessive dimensions before allocation", () => {
    const gif = makeGif(2, 2, [
      { width: 2, height: 2, data: D0 },
      { width: 65535, height: 65535, data: D0 }
    ]);
    expect(() => decodeGifFramesRgba(gif)).toThrowError(/file-too-large/);
    expect(() => sniffImageHeader(gif)).toThrowError(/file-too-large/);
  });

  it("rejects a GIF with excessive frame count", () => {
    const frames = Array.from({ length: 301 }, () => ({ width: 1, height: 1, data: D0 }));
    const gif = makeGif(1, 1, frames);
    expect(() => decodeGifFramesRgba(gif)).toThrowError(/file-too-large/);
    expect(() => sniffImageHeader(gif)).toThrowError(/file-too-large/);
  });

  it("rejects a GIF that exceeds the cumulative decoded RGBA memory budget", () => {
    const frames = Array.from({ length: 300 }, () => ({ width: 512, height: 512, data: D0 }));
    const gif = makeGif(512, 512, frames);
    expect(() => decodeGifFramesRgba(gif)).toThrowError(/file-too-large/);
    expect(() => sniffImageHeader(gif)).toThrowError(/file-too-large/);
  });

  // A 512x512 canvas retains 1 MiB per decoded frame, so the 256 MiB budget
  // fits 254 plain frames, or 253 when each frame keeps a disposal buffer.
  it.each([
    { count: 254, disposal: 0, exportOk: true },
    { count: 255, disposal: 0, exportOk: false },
    { count: 253, disposal: 3, exportOk: true },
    { count: 254, disposal: 3, exportOk: false }
  ])(
    "probe and export agree on the decoded memory budget: $count frames, disposal method $disposal",
    ({ count, disposal, exportOk }) => {
      const frames = Array.from({ length: count }, () => ({
        width: 512,
        height: 512,
        data: D0,
        gce: { disposal }
      }));
      const gif = makeGif(512, 512, frames);
      if (exportOk) {
        expect(decodeGifFramesRgba(gif)).toHaveLength(count);
        expect(sniffImageHeader(gif).frame_count).toBe(count);
      } else {
        expect(() => decodeGifFramesRgba(gif)).toThrowError(/file-too-large/);
        expect(() => sniffImageHeader(gif)).toThrowError(/file-too-large/);
      }
    }
  );

  it("rejects a GIF with invalid frame bounds", () => {
    const gif = makeGif(4, 4, [{ left: 3, top: 3, width: 2, height: 2, data: D0 }]);
    expect(() => decodeGifFramesRgba(gif)).toThrowError(/unsupported-image/);
    expect(() => sniffImageHeader(gif)).toThrowError(/unsupported-image/);
  });

  it("accepts a valid animated GIF just below the applicable limits", () => {
    const frames = Array.from({ length: 299 }, () => ({ width: 1, height: 1, data: D0 }));
    const gif = makeGif(1, 1, frames);
    const decoded = decodeGifFramesRgba(gif);
    expect(decoded).toHaveLength(299);
    const probe = sniffImageHeader(gif);
    expect(probe.frame_count).toBe(299);
  });

  it("preserves disposal methods, transparency and timing", () => {
    const gif = makeGif(2, 2, [
      { width: 2, height: 2, data: D0, gce: { disposal: 0, delayCs: 20 } },
      { left: 0, top: 0, width: 1, height: 1, data: D1, gce: { disposal: 2, delayCs: 30, transparentIndex: 3 } },
      { left: 1, top: 1, width: 1, height: 1, data: D2, gce: { disposal: 0, delayCs: 40 } }
    ]);
    const decoded = decodeGifFramesRgba(gif);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]!.delayMs).toBe(200);
    expect(decoded[1]!.delayMs).toBe(300);
    expect(decoded[2]!.delayMs).toBe(400);
    expect(Array.from(decoded[0]!.rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(decoded[1]!.rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
    expect(Array.from(decoded[1]!.rgba.slice(4, 8))).toEqual([255, 0, 0, 255]);
    expect(Array.from(decoded[2]!.rgba.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(decoded[2]!.rgba.slice(12, 16))).toEqual([0, 0, 255, 255]);
    expect(Array.from(decoded[2]!.rgba.slice(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it("restores the previous canvas for disposal method 3", () => {
    const gif = makeGif(2, 2, [
      { width: 2, height: 2, data: D0, gce: { disposal: 1, delayCs: 10 } },
      { left: 0, top: 0, width: 1, height: 1, data: D1, gce: { disposal: 3, delayCs: 10 } },
      { left: 1, top: 1, width: 1, height: 1, data: D2, gce: { disposal: 0, delayCs: 10 } }
    ]);
    const decoded = decodeGifFramesRgba(gif);
    expect(decoded).toHaveLength(3);
    expect(Array.from(decoded[2]!.rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(decoded[2]!.rgba.slice(12, 16))).toEqual([0, 0, 255, 255]);
  });

  it("skips transparent pixels declared by the graphic control extension", () => {
    const gif = makeGif(2, 2, [
      { width: 2, height: 2, data: D0, gce: { disposal: 0, delayCs: 10 } },
      { left: 1, top: 0, width: 1, height: 1, data: D0, gce: { disposal: 0, delayCs: 10, transparentIndex: 0 } }
    ]);
    const decoded = decodeGifFramesRgba(gif);
    expect(Array.from(decoded[1]!.rgba.slice(4, 8))).toEqual([255, 0, 0, 255]);
  });
});

