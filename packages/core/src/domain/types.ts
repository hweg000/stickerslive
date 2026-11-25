import { LIMITS } from "./limits";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif";
/** Short video clips used as an animated sticker source (web build). */
export type VideoFormat = "mp4" | "mov" | "webm";
export type StickerFormat = ImageFormat | VideoFormat;

export function isVideoFormat(format: string): format is VideoFormat {
  return format === "mp4" || format === "mov" || format === "webm";
}

/** MIME type for building a Blob of a sticker asset. MOV is labelled MP4 so Chromium will open it. */
export function stickerMimeType(format: StickerFormat): string {
  if (format === "webm") return "video/webm";
  if (format === "mp4" || format === "mov") return "video/mp4";
  return `image/${format}`;
}
export type AudioFormat = "mp3" | "wav" | "ogg" | "m4a" | "aac";
export type ExportProfileId =
  | "video-mp4"
  | "video-webm-alpha"
  | "sound-bundle"
  | "standard-webp"
  | "native-sound-sticker";

export type StrokeOption = "none" | "white-8px";
export type PreviewBackground = "checker" | "white" | "black" | "gray";

export interface StickerEdit {
  fit: "contain";
  offset_x: number;
  offset_y: number;
  scale: number;
  stroke: StrokeOption;
  matte_color?: string;
  crop_x?: number;
  crop_y?: number;
}

export interface StickerAsset {
  id: string;
  file: string;
  source_name: string;
  format: StickerFormat;
  width: number;
  height: number;
  has_alpha: boolean;
  animated: boolean;
  duration_ms?: number;
  edit: StickerEdit;
}

export interface AudioSource {
  /** "video-track": the sound was taken from the video sticker itself. */
  type: "local" | "myinstants" | "video-track";
  page_url?: string | null;
  media_url?: string | null;
  title?: string | null;
}

export interface AudioAsset {
  id: string;
  file: string;
  source_name: string;
  format: AudioFormat;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  source: AudioSource;
}

export interface Association {
  id: string;
  sticker_id: string;
  audio_id: string;
  start_ms: number;
  end_ms: number;
  volume: number;
  fade_in_ms: number;
  fade_out_ms: number;
}

export interface BundleMetadata {
  kind: "sound-bundle";
  created_at: string;
  files: {
    sticker: "sticker.webp";
    audio: "sound.ogg";
  };
  audio_encoding: {
    container: "ogg";
    codec: "opus";
    channels: 1;
    sample_rate: 48000;
    bitrate_bps: 64000;
  };
  limits: {
    sticker_px: 512;
    max_static_bytes: 102400;
    max_audio_ms: number;
  };
  whatsapp_native: false;
}

export interface ProjectManifest {
  schema_version: "1.0";
  project: {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
  };
  stickers: StickerAsset[];
  audios: AudioAsset[];
  associations: Association[];
  active_association_id?: string | null;
  export: {
    profile: ExportProfileId;
    target: "whatsapp";
  };
  bundle?: BundleMetadata;
}

export interface ImageProbeInfo {
  format: StickerFormat;
  width: number;
  height: number;
  has_alpha: boolean;
  animated: boolean;
  frame_count: number;
  duration_ms: number;
}

export interface AudioProbeInfo {
  format: AudioFormat;
  duration_ms: number;
  sample_rate: number;
  channels: number;
}

export interface RgbaFrame512 {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface PcmMono48k {
  sampleRate: 48000;
  channels: 1;
  samples: Float32Array;
  durationMs: number;
}

export interface PeakBuckets {
  buckets: number;
  mins: Float32Array;
  maxs: Float32Array;
}

export interface VideoRenderRequest {
  stickerBytes: Uint8Array;
  stickerFormat: StickerFormat;
  animated: boolean;
  /** Source size; needed for video stickers, whose header the engine does not sniff. */
  stickerWidth?: number;
  stickerHeight?: number;
  /** Video stickers: where in the clip the rendered segment starts. */
  videoOffsetMs?: number;
  /** Minimum output duration (e.g. animated GIF loop length) in ms. */
  minDurationMs?: number;
  audioBytes: Uint8Array;
  audioFormat: AudioFormat;
  startMs: number;
  endMs: number;
  volume: number;
  matteColor: string;
  cropX?: number;
  cropY?: number;
  /** Zoom of the square crop (StickerEdit.scale); see computeSquareCrop. */
  cropZoom?: number;
  container: "mp4" | "webm-alpha";
}

export interface VideoRenderResult {
  bytes: Uint8Array;
  mimeType: "video/mp4" | "video/webm";
  extension: "mp4" | "webm";
  durationMs: number;
  hasAlpha: boolean;
}

export interface ZipEntryInput {
  path: string;
  bytes: Uint8Array;
}

export interface MediaEngine {
  probeImage(bytes: Uint8Array): Promise<ImageProbeInfo>;
  renderSticker(bytes: Uint8Array, edit: StickerEdit): Promise<RgbaFrame512>;
  encodeWebp(frame: RgbaFrame512): Promise<Uint8Array>;
  probeAudio(bytes: Uint8Array): Promise<AudioProbeInfo>;
  waveform(bytes: Uint8Array): Promise<PeakBuckets>;
  renderAudio(bytes: Uint8Array, edit: { start_ms: number; end_ms: number; volume: number }): Promise<PcmMono48k>;
  encodeOpus(pcm: PcmMono48k): Promise<Uint8Array>;
  renderVideo(request: VideoRenderRequest): Promise<VideoRenderResult>;
  /**
   * Video stickers: pull the clip's sound out as a mono WAV so it can be trimmed like any audio.
   * Returns a silent track of the clip's length when the video has no readable sound.
   */
  extractAudioTrack?(videoBytes: Uint8Array, durationMs: number): Promise<{ wavBytes: Uint8Array; silent: boolean }>;
  zip(entries: ZipEntryInput[]): Promise<Uint8Array>;
  unzip(zipBytes: Uint8Array): Promise<ZipEntryInput[]>;
}

export interface SoundProvider {
  readonly id: string;
  canResolve(rawUrl: string): boolean;
  resolve(rawUrl: string): Promise<{
    page_url: string | null;
    media_url: string;
    title: string | null;
    bytes: Uint8Array;
  }>;
}

export interface ExportProfileDefinition {
  id: ExportProfileId;
  enabled: boolean;
  requiresAudio: boolean;
  maxAudioMs: number;
  extension: "mp4" | "webm" | "zip" | "webp";
  mimeType: string;
}

export const EXPORT_PROFILES: Record<ExportProfileId, ExportProfileDefinition> = {
  "video-mp4": {
    id: "video-mp4",
    enabled: true,
    requiresAudio: true,
    maxAudioMs: LIMITS.DEFAULT_VIDEO_MAX_AUDIO_MS,
    extension: "mp4",
    mimeType: "video/mp4"
  },
  "video-webm-alpha": {
    id: "video-webm-alpha",
    enabled: true,
    requiresAudio: true,
    maxAudioMs: LIMITS.DEFAULT_VIDEO_MAX_AUDIO_MS,
    extension: "webm",
    mimeType: "video/webm"
  },
  "sound-bundle": {
    id: "sound-bundle",
    enabled: true,
    requiresAudio: true,
    maxAudioMs: LIMITS.DEFAULT_BUNDLE_MAX_AUDIO_MS,
    extension: "zip",
    mimeType: "application/zip"
  },
  "standard-webp": {
    id: "standard-webp",
    enabled: true,
    requiresAudio: false,
    maxAudioMs: LIMITS.DEFAULT_VIDEO_MAX_AUDIO_MS,
    extension: "webp",
    mimeType: "image/webp"
  },
  "native-sound-sticker": {
    id: "native-sound-sticker",
    enabled: false,
    requiresAudio: true,
    maxAudioMs: LIMITS.DEFAULT_VIDEO_MAX_AUDIO_MS,
    extension: "webp",
    mimeType: "application/octet-stream"
  }
};
