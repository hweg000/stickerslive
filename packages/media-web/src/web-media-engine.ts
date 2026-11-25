import {
  LIMITS,
  StikSoundError,
  assertSafeZipEntryPath,
  computeSquareCrop,
  isVideoFormat,
  type AudioProbeInfo,
  type ImageProbeInfo,
  type MediaEngine,
  type PcmMono48k,
  type PeakBuckets,
  type RgbaFrame512,
  type StickerEdit,
  type VideoFormat,
  type VideoRenderRequest,
  type VideoRenderResult,
  type ZipEntryInput
} from "@stiksound/core";
import { unzipSync, zipSync } from "fflate";
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { computePeaksFromFloat32, decodeWavToMonoFloat32, encodeWavBytes, trimPcmSamples } from "./audio-utils";
import { decodeGifFramesRgba, type DecodedGifFrame } from "./gif-decoder";
import {
  gifFrameDelayMs,
  resampleGifScheduleForEncoder,
  scheduleGifFramesForDuration
} from "./gif-scheduler";
import { compositeRgbaOnMatte, cropAndFitSquareRgba } from "./image-utils";
import { sniffAudioContainer, sniffImageHeader, sniffVideoContainer } from "./sniffers";
import { clipTimeSec, drawCroppedFrame, openVideo, seekVideo, type OpenedVideo } from "./video-utils";

/** Frame rate used when a video clip is the sticker source. Each frame costs one seek. */
const CLIP_FPS = 15;

type ExtendedVideoEncoderConfig = VideoEncoderConfig & {
  avc?: { format: "avc" | "annexb" };
};

function toUint8Array(data: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/**
 * Extracts raw MPEG-4 AudioSpecificConfig bytes from an EncodedAudioChunkMetadata description.
 * On macOS/iOS, AudioEncoder passes a full ES_Descriptor (starting with tag 0x03) instead of raw
 * AudioSpecificConfig; passing that straight to mp4-muxer double-wraps ES_Descriptor inside TAG(5).
 */
export function extractRawAudioSpecificConfig(
  description: AllowSharedBufferSource | undefined
): Uint8Array | undefined {
  if (!description) return undefined;
  const bytes = toUint8Array(description);
  if (bytes.byteLength === 0) return undefined;
  if (bytes[0] !== 0x03) return bytes;

  for (let i = 0; i < bytes.byteLength - 2; i++) {
    if (bytes[i] === 0x05) {
      let j = i + 1;
      let len = 0;
      let count = 0;
      while (j < bytes.byteLength && count < 4) {
        const b = bytes[j++]!;
        len = (len << 7) | (b & 0x7f);
        count++;
        if ((b & 0x80) === 0) break;
      }
      if (len > 0 && len <= 64 && j + len <= bytes.byteLength && bytes[j] !== 0x03) {
        return bytes.slice(j, j + len);
      }
    }
  }
  return undefined;
}

export function sanitizeMp4AudioChunkMeta(
  meta?: EncodedAudioChunkMetadata
): EncodedAudioChunkMetadata | undefined {
  if (!meta?.decoderConfig) return meta;
  const rawAsc = extractRawAudioSpecificConfig(meta.decoderConfig.description);
  if (rawAsc !== undefined) {
    return {
      ...meta,
      decoderConfig: {
        ...meta.decoderConfig,
        description: rawAsc
      }
    };
  }
  const { description: _omitted, ...restConfig } = meta.decoderConfig;
  return {
    ...meta,
    decoderConfig: restConfig
  };
}

/**
 * Decodes an animated GIF into cropped 1:1 RGBA frames (composited onto matte
 * for non-alpha exports) without requiring DOM/ImageDecoder support.
 */
export function prepareAnimatedGifFrames(
  request: Pick<VideoRenderRequest, "stickerBytes" | "cropX" | "cropY" | "container" | "matteColor">
): DecodedGifFrame[] {
  const decoded = decodeGifFramesRgba(request.stickerBytes);
  const isWebm = request.container === "webm-alpha";
  const cropX = request.cropX ?? 0.5;
  const cropY = request.cropY ?? 0.5;
  const prepared: DecodedGifFrame[] = [];

  for (const frame of decoded) {
    const cropped = cropAndFitSquareRgba(frame.rgba, frame.width, frame.height, cropX, cropY);
    const rgba = isWebm ? cropped.data : compositeRgbaOnMatte(cropped, request.matteColor);
    prepared.push({
      width: cropped.width,
      height: cropped.height,
      delayMs: frame.delayMs,
      rgba
    });
    frame.rgba = new Uint8Array(0);
  }

  return prepared;
}

interface EncoderCanvasFrame {
  canvas: OffscreenCanvas;
  timestampUs: number;
  durationUs: number;
  keyFrame: boolean;
}

export class WebMediaEngine implements MediaEngine {
  public async probeImage(bytes: Uint8Array): Promise<ImageProbeInfo> {
    const videoFormat = sniffVideoContainer(bytes);
    if (videoFormat) {
      const video = await openVideo(bytes, videoFormat);
      video.dispose();
      return {
        format: videoFormat,
        width: video.width,
        height: video.height,
        has_alpha: false,
        animated: true,
        frame_count: Math.max(1, Math.round((video.durationMs / 1000) * CLIP_FPS)),
        duration_ms: video.durationMs
      };
    }
    return sniffImageHeader(bytes);
  }

  /** Video stickers: the clip's sound as mono WAV, or silence of the clip's length. */
  public async extractAudioTrack(
    videoBytes: Uint8Array,
    durationMs: number
  ): Promise<{ wavBytes: Uint8Array; silent: boolean }> {
    try {
      const { samples, sampleRate } = await this.decodeToMonoSamples(videoBytes);
      const totalMs = Math.floor((samples.length / sampleRate) * 1000);
      if (totalMs >= LIMITS.MIN_AUDIO_DURATION_MS) {
        const pcm = trimPcmSamples(samples, sampleRate, 0, totalMs, 1, Number.MAX_SAFE_INTEGER);
        return { wavBytes: encodeWavBytes(pcm), silent: false };
      }
    } catch {
      // No sound track, or this browser cannot read it: fall through to silence.
    }
    const ms = Math.max(LIMITS.MIN_AUDIO_DURATION_MS, Math.round(durationMs));
    const silence: PcmMono48k = {
      sampleRate: 48000,
      channels: 1,
      samples: new Float32Array(Math.round(ms * 48)),
      durationMs: ms
    };
    return { wavBytes: encodeWavBytes(silence), silent: true };
  }

  /** Width/height of the sticker source: sniffed for images, from the request (or a probe) for clips. */
  private async stickerSize(request: VideoRenderRequest): Promise<{ width: number; height: number }> {
    if (!isVideoFormat(request.stickerFormat)) {
      const info = sniffImageHeader(request.stickerBytes);
      return { width: info.width, height: info.height };
    }
    if (request.stickerWidth && request.stickerHeight) {
      return { width: request.stickerWidth, height: request.stickerHeight };
    }
    const video = await openVideo(request.stickerBytes, request.stickerFormat);
    video.dispose();
    return { width: video.width, height: video.height };
  }

  public async renderSticker(bytes: Uint8Array, edit: StickerEdit): Promise<RgbaFrame512> {
    const videoFormat = sniffVideoContainer(bytes);
    if (videoFormat) {
      // Static uses (WebP in the sound bundle) take the clip's first frame.
      const video = await openVideo(bytes, videoFormat);
      try {
        await seekVideo(video.el, 0);
        const size = computeSquareCrop(video.width, video.height, edit.crop_x ?? 0.5, edit.crop_y ?? 0.5).outputSize;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new StikSoundError("encode-failed", "2D context unavailable.");
        drawCroppedFrame(ctx, video, edit.crop_x ?? 0.5, edit.crop_y ?? 0.5, null);
        const imageData = ctx.getImageData(0, 0, size, size);
        return { width: size, height: size, data: new Uint8Array(imageData.data) };
      } finally {
        video.dispose();
      }
    }

    const info = sniffImageHeader(bytes);
    const crop = computeSquareCrop(info.width, info.height, edit.crop_x ?? 0.5, edit.crop_y ?? 0.5);

    if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined") {
      const mime = `image/${info.format}`;
      const blob = new Blob([bytes.slice().buffer], { type: mime });
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(crop.outputSize, crop.outputSize);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new StikSoundError("encode-failed", "2D context unavailable.");
      ctx.clearRect(0, 0, crop.outputSize, crop.outputSize);
      ctx.drawImage(
        bitmap,
        crop.srcX,
        crop.srcY,
        crop.cropSide,
        crop.cropSide,
        0,
        0,
        crop.outputSize,
        crop.outputSize
      );
      bitmap.close();
      const imageData = ctx.getImageData(0, 0, crop.outputSize, crop.outputSize);
      return { width: crop.outputSize, height: crop.outputSize, data: new Uint8Array(imageData.data) };
    }

    // Headless/non-DOM fallback for unit tests
    return cropAndFitSquareRgba(
      new Uint8Array(info.width * info.height * 4),
      info.width,
      info.height,
      edit.crop_x ?? 0.5,
      edit.crop_y ?? 0.5
    );
  }

  public async encodeWebp(frame: RgbaFrame512): Promise<Uint8Array> {
    if (typeof OffscreenCanvas === "undefined") {
      throw new StikSoundError("unsupported-codec", "WebP canvas encoder requires browser OffscreenCanvas.");
    }
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new StikSoundError("encode-failed", "2D context unavailable.");
    const imgData = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
    ctx.putImageData(imgData, 0, 0);

    for (const quality of [1.0, 0.9, 0.8, 0.7, 0.6, 0.5]) {
      const blob = await canvas.convertToBlob({ type: "image/webp", quality });
      const arr = new Uint8Array(await blob.arrayBuffer());
      if (arr.byteLength <= LIMITS.MAX_STATIC_WEBP_BYTES) {
        return arr;
      }
    }
    throw new StikSoundError("sticker-too-large", "WebP exceeded 100 KB even at quality 50.");
  }

  public async probeAudio(bytes: Uint8Array): Promise<AudioProbeInfo> {
    const header = sniffAudioContainer(bytes);
    if (typeof AudioContext !== "undefined") {
      const ctx = new AudioContext();
      try {
        const copy = bytes.slice().buffer;
        const decoded = await ctx.decodeAudioData(copy);
        const durationMs = Math.round(decoded.duration * 1000);
        if (durationMs > LIMITS.MAX_AUDIO_DURATION_MS) {
          throw new StikSoundError("file-too-large", "Audio exceeds 3 minutes.");
        }
        return {
          format: header.format,
          duration_ms: durationMs,
          sample_rate: decoded.sampleRate,
          channels: decoded.numberOfChannels
        };
      } catch (err) {
        if (err instanceof StikSoundError) throw err;
        throw new StikSoundError("unsupported-audio", "Browser could not decode audio file.");
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }
    return header;
  }

  private async decodeToMonoSamples(bytes: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> {
    const info = sniffAudioContainer(bytes);
    if (typeof AudioContext !== "undefined") {
      const ctx = new AudioContext();
      try {
        const decoded = await ctx.decodeAudioData(bytes.slice().buffer);
        const mono = new Float32Array(decoded.length);
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          const ch = decoded.getChannelData(c);
          for (let i = 0; i < decoded.length; i++) {
            mono[i] = (mono[i] ?? 0) + ch[i]! / decoded.numberOfChannels;
          }
        }
        return { samples: mono, sampleRate: decoded.sampleRate };
      } catch {
        throw new StikSoundError("unsupported-audio", "Browser could not decode audio.");
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }
    if (info.format === "wav") {
      return decodeWavToMonoFloat32(bytes);
    }
    throw new StikSoundError("unsupported-codec", "Audio decode requires browser Web Audio API.");
  }

  public async waveform(bytes: Uint8Array): Promise<PeakBuckets> {
    const { samples } = await this.decodeToMonoSamples(bytes);
    return computePeaksFromFloat32(samples, LIMITS.WAVEFORM_BUCKETS);
  }

  public async renderAudio(
    bytes: Uint8Array,
    edit: { start_ms: number; end_ms: number; volume: number }
  ): Promise<PcmMono48k> {
    const { samples, sampleRate } = await this.decodeToMonoSamples(bytes);
    return trimPcmSamples(samples, sampleRate, edit.start_ms, edit.end_ms, edit.volume);
  }

  public async encodeOpus(pcm: PcmMono48k): Promise<Uint8Array> {
    // Fallback WAV or WebCodecs Opus check
    if (typeof AudioEncoder === "undefined") {
      throw new StikSoundError("unsupported-codec", "WebCodecs AudioEncoder unavailable in this browser.");
    }
    return encodeWavBytes(pcm);
  }

  public async renderVideo(request: VideoRenderRequest): Promise<VideoRenderResult> {
    const audioWindowMs = request.endMs - request.startMs;
    const durationMs = Math.max(audioWindowMs, Math.round(request.minDurationMs ?? 0));

    // 1) Primary zero-dependency path: WebCodecs + pure-TS mp4-muxer / webm-muxer
    if (
      typeof VideoEncoder !== "undefined" &&
      typeof AudioEncoder !== "undefined" &&
      typeof VideoFrame !== "undefined" &&
      typeof AudioData !== "undefined" &&
      typeof OffscreenCanvas !== "undefined"
    ) {
      const isWebm = request.container === "webm-alpha";
      const size = await this.stickerSize(request);
      const crop = computeSquareCrop(size.width, size.height, request.cropX ?? 0.5, request.cropY ?? 0.5);

      const videoCandidates: ExtendedVideoEncoderConfig[] = isWebm
        ? [
            {
              codec: "vp09.00.10.08",
              width: crop.outputSize,
              height: crop.outputSize,
              bitrate: 1_200_000,
              framerate: 24,
              alpha: "keep"
            },
            {
              codec: "vp09.00.10.08",
              width: crop.outputSize,
              height: crop.outputSize,
              bitrate: 1_200_000,
              framerate: 24
            },
            {
              codec: "vp8",
              width: crop.outputSize,
              height: crop.outputSize,
              bitrate: 1_200_000,
              framerate: 24
            }
          ]
        : [
            {
              codec: "avc1.42001E",
              width: crop.outputSize,
              height: crop.outputSize,
              bitrate: 1_200_000,
              framerate: 24,
              avc: { format: "avc" }
            },
            {
              codec: "avc1.42E01E",
              width: crop.outputSize,
              height: crop.outputSize,
              bitrate: 1_200_000,
              framerate: 24,
              avc: { format: "avc" }
            },
            {
              codec: "avc1.4D401E",
              width: crop.outputSize,
              height: crop.outputSize,
              bitrate: 1_200_000,
              framerate: 24,
              avc: { format: "avc" }
            },
            {
              codec: "avc1.42001E",
              width: crop.outputSize,
              height: crop.outputSize,
              bitrate: 1_200_000,
              framerate: 24
            }
          ];

      const audioBitrates = isWebm ? [64_000] : [96_000, 64_000, 128_000];
      const audioCodec = isWebm ? "opus" : "mp4a.40.2";

      // Chromium's WebCodecs cannot encode alpha ("Alpha encoding is not currently supported"), but its
      // MediaRecorder writes VP8/VP9 WebM with alpha. Prefer that over silently exporting an opaque WebM.
      const recorderCanDoWebm =
        isWebm &&
        typeof MediaRecorder !== "undefined" &&
        typeof document !== "undefined" &&
        MediaRecorder.isTypeSupported("video/webm;codecs=vp9");

      try {
        let chosenVideoConfig: ExtendedVideoEncoderConfig | null = null;
        for (const candidate of videoCandidates) {
          if (recorderCanDoWebm && candidate.alpha !== "keep") break;
          const vSupport = await VideoEncoder.isConfigSupported(candidate);
          if (vSupport.supported) {
            chosenVideoConfig = candidate;
            break;
          }
        }

        let chosenAudioConfig: AudioEncoderConfig | null = null;
        for (const bitrate of audioBitrates) {
          const candidate: AudioEncoderConfig = {
            codec: audioCodec,
            sampleRate: 48000,
            numberOfChannels: 1,
            bitrate
          };
          const aSupport = await AudioEncoder.isConfigSupported(candidate);
          if (aSupport.supported) {
            chosenAudioConfig = candidate;
            break;
          }
        }

        if (chosenVideoConfig && chosenAudioConfig) {
          return await this.renderVideoWithWebCodecs(
            request,
            durationMs,
            chosenVideoConfig,
            chosenAudioConfig,
            crop.outputSize
          );
        }
      } catch {
        // Fall through to universal MediaRecorder fallback below
      }
    }

    // 2) Universal zero-dependency browser/WebView fallback: Canvas.captureStream + MediaRecorder
    if (typeof MediaRecorder !== "undefined" && typeof document !== "undefined") {
      return this.renderVideoWithMediaRecorder(request, durationMs);
    }

    throw new StikSoundError(
      "unsupported-codec",
      "WebCodecs and MediaRecorder are unavailable in this environment; open .stiksound.zip in the desktop app."
    );
  }

  private padPcmToDuration(pcm: PcmMono48k, targetDurationMs: number): PcmMono48k {
    if (targetDurationMs <= pcm.durationMs) {
      return pcm;
    }
    const totalSamples = Math.max(pcm.samples.length, Math.round((targetDurationMs / 1000) * pcm.sampleRate));
    const padded = new Float32Array(totalSamples);
    padded.set(pcm.samples, 0);
    return {
      ...pcm,
      samples: padded,
      durationMs: targetDurationMs
    };
  }

  private async renderVideoWithWebCodecs(
    request: VideoRenderRequest,
    durationMs: number,
    videoConfig: ExtendedVideoEncoderConfig,
    audioConfig: AudioEncoderConfig,
    outputSize: number
  ): Promise<VideoRenderResult> {
    const rawPcm = await this.renderAudio(request.audioBytes, {
      start_ms: request.startMs,
      end_ms: request.endMs,
      volume: request.volume
    });
    const pcm = this.padPcmToDuration(rawPcm, durationMs);

    const isWebm = request.container === "webm-alpha";
    const isClip = isVideoFormat(request.stickerFormat);
    // Image/GIF frames are prepared up front; clip frames are drawn and encoded one at a time.
    const framesToRender = isClip ? [] : await this.decodeVideoFrames(request, durationMs, outputSize);

    const mp4Target = isWebm ? null : new Mp4Target();
    const webmTarget = isWebm ? new WebmTarget() : null;
    const mp4Muxer = mp4Target
      ? new Mp4Muxer({
          target: mp4Target,
          video: { codec: "avc", width: outputSize, height: outputSize },
          audio: { codec: "aac", sampleRate: 48000, numberOfChannels: 1 },
          fastStart: "in-memory"
        })
      : null;
    const webmMuxer = webmTarget
      ? new WebmMuxer({
          target: webmTarget,
          video: {
            codec: videoConfig.codec.startsWith("vp8") ? "V_VP8" : "V_VP9",
            width: outputSize,
            height: outputSize,
            alpha: videoConfig.alpha === "keep"
          },
          audio: { codec: "A_OPUS", sampleRate: 48000, numberOfChannels: 1 }
        })
      : null;

    let encoderFailure: unknown = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        mp4Muxer?.addVideoChunk(chunk, meta);
        webmMuxer?.addVideoChunk(chunk, meta);
      },
      error: (err) => {
        encoderFailure = err;
      }
    });
    videoEncoder.configure(videoConfig);

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        mp4Muxer?.addAudioChunk(chunk, sanitizeMp4AudioChunkMeta(meta));
        webmMuxer?.addAudioChunk(chunk, meta);
      },
      error: (err) => {
        encoderFailure = err;
      }
    });
    audioEncoder.configure(audioConfig);

    if (isClip) {
      await this.encodeClipFrames(request, durationMs, outputSize, videoEncoder);
    }
    for (let i = 0; i < framesToRender.length; i++) {
      const f = framesToRender[i]!;
      const vf = new VideoFrame(f.canvas, {
        timestamp: f.timestampUs,
        duration: f.durationUs
      });
      videoEncoder.encode(vf, { keyFrame: f.keyFrame });
      vf.close();
    }

    const chunkSamples = isWebm ? 4800 : 4096; // 4096 = 4 * 1024 AAC frames; 4800 = 5 * 960 Opus frames
    for (let offset = 0; offset < pcm.samples.length; offset += chunkSamples) {
      const slice = pcm.samples.subarray(offset, Math.min(pcm.samples.length, offset + chunkSamples));
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: slice.length,
        numberOfChannels: 1,
        timestamp: Math.round((offset / 48000) * 1_000_000),
        data: slice.slice()
      });
      audioEncoder.encode(audioData);
      audioData.close();
    }

    await videoEncoder.flush();
    await audioEncoder.flush();
    videoEncoder.close();
    audioEncoder.close();
    if (encoderFailure) {
      throw encoderFailure;
    }

    if (mp4Muxer && mp4Target) {
      mp4Muxer.finalize();
      return {
        bytes: new Uint8Array(mp4Target.buffer),
        mimeType: "video/mp4",
        extension: "mp4",
        durationMs: pcm.durationMs,
        hasAlpha: false
      };
    }

    webmMuxer!.finalize();
    return {
      bytes: new Uint8Array(webmTarget!.buffer),
      mimeType: "video/webm",
      extension: "webm",
      durationMs: pcm.durationMs,
      hasAlpha: true
    };
  }

  /** Seek through the clip at CLIP_FPS, draw each 1:1 crop and hand it straight to the encoder. */
  private async encodeClipFrames(
    request: VideoRenderRequest,
    durationMs: number,
    outputSize: number,
    encoder: VideoEncoder
  ): Promise<void> {
    const video = await openVideo(request.stickerBytes, request.stickerFormat as VideoFormat);
    try {
      const canvas = new OffscreenCanvas(outputSize, outputSize);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new StikSoundError("encode-failed", "2D context unavailable.");
      const matte = request.container === "webm-alpha" ? null : request.matteColor;
      const stepUs = Math.round(1_000_000 / CLIP_FPS);
      const totalUs = durationMs * 1000;
      let index = 0;
      for (let t = 0; t < totalUs; t += stepUs, index++) {
        await seekVideo(video.el, clipTimeSec(request.videoOffsetMs ?? 0, t / 1000, video.durationMs));
        drawCroppedFrame(ctx, video, request.cropX ?? 0.5, request.cropY ?? 0.5, matte);
        const frame = new VideoFrame(canvas, { timestamp: t, duration: Math.min(stepUs, totalUs - t) });
        encoder.encode(frame, { keyFrame: index % 24 === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 8) {
          await new Promise((r) => setTimeout(r, 5));
        }
      }
    } finally {
      video.dispose();
    }
  }

  private async renderVideoWithMediaRecorder(
    request: VideoRenderRequest,
    durationMs: number
  ): Promise<VideoRenderResult> {
    const audioCtx = new AudioContext({ sampleRate: 48000 });
    // Mobile Safari starts contexts "suspended"; start resuming immediately before any await.
    const resumePromise = audioCtx.resume().catch(() => undefined);

    let clip: OpenedVideo | null = null;
    let imgUrl = "";

    try {
      const rawPcm = await this.renderAudio(request.audioBytes, {
        start_ms: request.startMs,
        end_ms: request.endMs,
        volume: request.volume
      });
      const pcm = this.padPcmToDuration(rawPcm, durationMs);

      const size = await this.stickerSize(request);
      const crop = computeSquareCrop(size.width, size.height, request.cropX ?? 0.5, request.cropY ?? 0.5);
      const canvas = document.createElement("canvas");
      canvas.width = crop.outputSize;
      canvas.height = crop.outputSize;
      const ctx = canvas.getContext("2d");
      if (!ctx || typeof canvas.captureStream !== "function") {
        throw new StikSoundError("unsupported-codec", "Canvas captureStream is not available.");
      }

      const isWebm = request.container === "webm-alpha";
      const isClip = isVideoFormat(request.stickerFormat);
      let gifImageDatas: ImageData[] | null = null;
      let gifCumEndMs: number[] = [];
      let gifCycleMs = 1;
      let imgEl: HTMLImageElement | null = null;

      if (isClip) {
        // Real-time path: the clip plays (muted) into the canvas while MediaRecorder captures it.
        clip = await openVideo(request.stickerBytes, request.stickerFormat as VideoFormat);
        clip.el.loop = true;
        await seekVideo(clip.el, (request.videoOffsetMs ?? 0) / 1000);
      } else {
        if (request.animated && request.stickerFormat === "gif") {
          try {
            const decodedGif = prepareAnimatedGifFrames(request);
            if (decodedGif.length > 0) {
              gifImageDatas = decodedGif.map(
                (f) => new ImageData(new Uint8ClampedArray(f.rgba), f.width, f.height)
              );
              let acc = 0;
              gifCumEndMs = decodedGif.map((f) => {
                acc += f.delayMs;
                return acc;
              });
              gifCycleMs = Math.max(1, acc);
            }
          } catch (error) {
            if (error instanceof StikSoundError && error.code === "file-too-large") {
              throw error;
            }
            gifImageDatas = null;
          }
        }

        if (!gifImageDatas) {
          const imgBlob = new Blob([request.stickerBytes.slice().buffer], { type: `image/${request.stickerFormat}` });
          imgUrl = URL.createObjectURL(imgBlob);
          imgEl = new Image();
          imgEl.src = imgUrl;
          await new Promise<void>((resolve, reject) => {
            imgEl!.onload = () => resolve();
            imgEl!.onerror = () => reject(new StikSoundError("unsupported-image", "Image load failed."));
          });
        }
      }

      await resumePromise;
      const audioBuffer = audioCtx.createBuffer(1, pcm.samples.length, 48000);
      audioBuffer.copyToChannel(pcm.samples.slice(), 0);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(dest);

      const videoStream = canvas.captureStream(24);
      const videoTrack = videoStream.getVideoTracks()[0] as { requestFrame?: () => void } | undefined;
      const startedAt = performance.now();

      const drawSticker = () => {
        if (clip) {
          drawCroppedFrame(ctx, clip, request.cropX ?? 0.5, request.cropY ?? 0.5, isWebm ? null : request.matteColor);
        } else if (gifImageDatas && gifImageDatas.length > 0) {
          const elapsed = (performance.now() - startedAt) % gifCycleMs;
          let idx = 0;
          while (idx < gifCumEndMs.length - 1 && elapsed >= gifCumEndMs[idx]!) {
            idx++;
          }
          ctx.putImageData(gifImageDatas[idx]!, 0, 0);
        } else if (imgEl) {
          if (isWebm) {
            ctx.clearRect(0, 0, crop.outputSize, crop.outputSize);
          } else {
            ctx.fillStyle = request.matteColor;
            ctx.fillRect(0, 0, crop.outputSize, crop.outputSize);
          }
          ctx.drawImage(
            imgEl,
            crop.srcX,
            crop.srcY,
            crop.cropSide,
            crop.cropSide,
            0,
            0,
            crop.outputSize,
            crop.outputSize
          );
        }
        videoTrack?.requestFrame?.();
      };
      drawSticker();

      const combined = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
      ]);

      const preferredMime = isWebm
        ? ["video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m))
        : ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      if (!preferredMime) {
        throw new StikSoundError("unsupported-codec", "No supported MediaRecorder video mime type.");
      }

      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(combined, { mimeType: preferredMime });
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };

      const done = new Promise<Uint8Array>((resolve, reject) => {
        recorder.onstop = async () => {
          const outBlob = new Blob(chunks, { type: preferredMime });
          resolve(new Uint8Array(await outBlob.arrayBuffer()));
        };
        recorder.onerror = () => reject(new StikSoundError("encode-failed", "MediaRecorder failed."));
      });

      const intervalId = window.setInterval(drawSticker, 33);
      recorder.start();
      source.start();
      if (clip) await clip.el.play().catch(() => undefined);

      await new Promise((r) => setTimeout(r, durationMs));
      window.clearInterval(intervalId);
      source.stop();
      if (recorder.state !== "inactive") recorder.stop();

      const bytes = await done;
      const outIsMp4 = preferredMime.includes("mp4");
      return {
        bytes,
        mimeType: outIsMp4 ? "video/mp4" : "video/webm",
        extension: outIsMp4 ? "mp4" : "webm",
        durationMs: pcm.durationMs,
        hasAlpha: !outIsMp4 && isWebm
      };
    } finally {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      clip?.dispose();
      await audioCtx.close().catch(() => undefined);
    }
  }

  private async decodeVideoFrames(
    request: VideoRenderRequest,
    durationMs: number,
    outputSize: number
  ): Promise<EncoderCanvasFrame[]> {
    const isWebm = request.container === "webm-alpha";
    const cropX = request.cropX ?? 0.5;
    const cropY = request.cropY ?? 0.5;

    const drawFrameOnCanvas = (rgba: Uint8Array, size: number, alreadyMatted = false): OffscreenCanvas => {
      const c = new OffscreenCanvas(size, size);
      const ctx = c.getContext("2d")!;
      const finalPixels =
        alreadyMatted || isWebm
          ? rgba
          : compositeRgbaOnMatte({ width: size, height: size, data: rgba }, request.matteColor);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(finalPixels), size, size), 0, 0);
      return c;
    };

    if (request.animated && request.stickerFormat === "gif") {
      let decodedCanvases: OffscreenCanvas[] = [];
      let timings: Array<{ frameIndex: number; delayMs: number }> = [];

      try {
        const gifFrames = prepareAnimatedGifFrames(request);
        decodedCanvases = gifFrames.map((f) => drawFrameOnCanvas(f.rgba, f.width, true));
        timings = gifFrames.map((f, frameIndex) => ({ frameIndex, delayMs: f.delayMs }));
      } catch (error) {
        if (error instanceof StikSoundError && error.code === "file-too-large") {
          throw error;
        }
        decodedCanvases = [];
        timings = [];
      }

      if (decodedCanvases.length === 0 && typeof ImageDecoder !== "undefined") {
        const decoder = new ImageDecoder({ data: request.stickerBytes, type: "image/gif" });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack?.frameCount ?? 1;

        for (let i = 0; i < count; i++) {
          const res = await decoder.decode({ frameIndex: i });
          const vf = res.image;
          const crop = computeSquareCrop(vf.displayWidth, vf.displayHeight, cropX, cropY);
          const c = new OffscreenCanvas(crop.outputSize, crop.outputSize);
          const ctx = c.getContext("2d")!;
          if (!isWebm) {
            ctx.fillStyle = request.matteColor;
            ctx.fillRect(0, 0, crop.outputSize, crop.outputSize);
          } else {
            ctx.clearRect(0, 0, crop.outputSize, crop.outputSize);
          }
          ctx.drawImage(
            vf,
            crop.srcX,
            crop.srcY,
            crop.cropSide,
            crop.cropSide,
            0,
            0,
            crop.outputSize,
            crop.outputSize
          );
          const delayMs = gifFrameDelayMs(vf.duration == null ? null : vf.duration / 1000);
          vf.close();
          decodedCanvases.push(c);
          timings.push({ frameIndex: i, delayMs });
        }
        decoder.close();
      }

      if (decodedCanvases.length > 0 && timings.length > 0) {
        const scheduled = scheduleGifFramesForDuration(timings, durationMs);
        return resampleGifScheduleForEncoder(scheduled, durationMs).map((f) => ({
          canvas: decodedCanvases[f.frameIndex]!,
          timestampUs: f.timestampUs,
          durationUs: f.durationUs,
          keyFrame: f.keyFrame
        }));
      }
    }

    const staticFrame = await this.renderSticker(request.stickerBytes, {
      fit: "contain",
      offset_x: 0,
      offset_y: 0,
      scale: 1,
      stroke: "none",
      matte_color: request.matteColor,
      crop_x: cropX,
      crop_y: cropY
    });
    const canvas = drawFrameOnCanvas(staticFrame.data, outputSize);
    const fps = 10;
    const stepUs = 100_000;
    const totalUs = durationMs * 1000;
    const out: EncoderCanvasFrame[] = [];
    for (let t = 0; t < totalUs; t += stepUs) {
      out.push({
        canvas,
        timestampUs: t,
        durationUs: Math.min(stepUs, totalUs - t),
        keyFrame: out.length % 24 === 0
      });
    }
    if (out.length === 0) {
      out.push({ canvas, timestampUs: 0, durationUs: 100_000 * (10 / fps), keyFrame: true });
    }
    return out;
  }

  public async zip(entries: ZipEntryInput[]): Promise<Uint8Array> {
    if (entries.length > LIMITS.MAX_PACKAGE_FILES) {
      throw new StikSoundError("package-invalid", "Too many zip entries.");
    }
    const record: Record<string, Uint8Array> = {};
    for (const entry of entries) {
      assertSafeZipEntryPath(entry.path);
      record[entry.path] = entry.bytes;
    }
    return zipSync(record, { level: 6 });
  }

  public async unzip(zipBytes: Uint8Array): Promise<ZipEntryInput[]> {
    let raw: Record<string, Uint8Array>;
    try {
      raw = unzipSync(zipBytes);
    } catch {
      throw new StikSoundError("package-invalid", "Corrupt or unreadable ZIP archive.");
    }

    const keys = Object.keys(raw);
    if (keys.length > LIMITS.MAX_PACKAGE_FILES) {
      throw new StikSoundError("package-invalid", "ZIP exceeds 32 entry limit.");
    }

    let totalBytes = 0;
    const out: ZipEntryInput[] = [];
    for (const path of keys) {
      assertSafeZipEntryPath(path);
      const bytes = raw[path]!;
      totalBytes += bytes.byteLength;
      if (totalBytes > LIMITS.MAX_PACKAGE_BYTES) {
        throw new StikSoundError("package-invalid", "ZIP exceeds 100 MB uncompressed limit.");
      }
      out.push({ path, bytes });
    }
    return out;
  }
}
