import { clampVolume, defaultTrimForDuration, validateAudioTrim } from "../domain/audio-trim";
import { StikSoundError } from "../domain/errors";
import { LIMITS } from "../domain/limits";
import { assertSafeZipEntryPath, sanitizeExportName, validateProjectManifest } from "../domain/schema-validator";
import {
  EXPORT_PROFILES,
  isVideoFormat,
  type Association,
  type AudioAsset,
  type AudioSource,
  type ExportProfileId,
  type MediaEngine,
  type PeakBuckets,
  type ProjectManifest,
  type SoundProvider,
  type StickerAsset,
  type StickerEdit,
  type ZipEntryInput
} from "../domain/types";

export interface ProjectWorkspaceState {
  manifest: ProjectManifest;
  assets: Map<string, Uint8Array>;
  waveformPeaks: PeakBuckets | null;
}

export interface ExportArtifact {
  profile: ExportProfileId;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  durationMs?: number;
}

function generateAssetId(prefix: "stk" | "aud" | "asc" | "prj"): string {
  const bytes = new Uint8Array(6);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

function nowUtcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function defaultStickerEdit(): StickerEdit {
  return {
    fit: "contain",
    offset_x: 0,
    offset_y: 0,
    scale: 1,
    stroke: "none",
    matte_color: LIMITS.DEFAULT_MATTE_COLOR,
    crop_x: 0.5,
    crop_y: 0.5
  };
}

export function createProject(name = "Untitled sticker", profile: ExportProfileId = "video-mp4"): ProjectWorkspaceState {
  const now = nowUtcIso();
  return {
    manifest: {
      schema_version: "1.0",
      project: {
        id: generateAssetId("prj"),
        name: name.trim().slice(0, 80) || "Untitled sticker",
        created_at: now,
        updated_at: now
      },
      stickers: [],
      audios: [],
      associations: [],
      active_association_id: null,
      export: {
        profile,
        target: "whatsapp"
      }
    },
    assets: new Map(),
    waveformPeaks: null
  };
}

export function resetProject(state: ProjectWorkspaceState): ProjectWorkspaceState {
  return createProject("Untitled sticker", state.manifest.export.profile);
}

export class ProjectController {
  constructor(
    private readonly engine: MediaEngine,
    private readonly providers: SoundProvider[] = []
  ) {}

  public async importSticker(
    state: ProjectWorkspaceState,
    bytes: Uint8Array,
    sourceName: string,
    maxAudioMsOverride?: number
  ): Promise<ProjectWorkspaceState> {
    if (bytes.byteLength === 0) {
      throw new StikSoundError("unsupported-image", "Empty image payload.");
    }
    if (bytes.byteLength > LIMITS.MAX_VIDEO_BYTES) {
      throw new StikSoundError("file-too-large", "File exceeds 100 MB limit.");
    }

    const probe = await this.engine.probeImage(bytes);
    const isVideo = isVideoFormat(probe.format);
    if (!isVideo && bytes.byteLength > LIMITS.MAX_IMAGE_BYTES) {
      throw new StikSoundError("file-too-large", "Image exceeds 20 MB limit.");
    }
    if (isVideo && probe.duration_ms > LIMITS.MAX_VIDEO_DURATION_MS) {
      throw new StikSoundError("file-too-large", "Video exceeds 60 s limit.");
    }
    if (
      probe.width <= 0 ||
      probe.height <= 0 ||
      probe.width > LIMITS.MAX_IMAGE_DIMENSION ||
      probe.height > LIMITS.MAX_IMAGE_DIMENSION ||
      probe.width * probe.height > LIMITS.MAX_IMAGE_PIXELS
    ) {
      throw new StikSoundError("file-too-large", "Image exceeds dimension or 40 MP limit.");
    }

    const id = generateAssetId("stk");
    const file = `assets/${id}.${probe.format}`;
    const sticker: StickerAsset = {
      id,
      file,
      source_name: sourceName.slice(0, 255) || `${id}.${probe.format}`,
      format: probe.format,
      width: probe.width,
      height: probe.height,
      has_alpha: probe.has_alpha,
      animated: probe.animated,
      ...(probe.duration_ms > 0 ? { duration_ms: Math.round(probe.duration_ms) } : {}),
      edit: defaultStickerEdit()
    };

    const nextAssets = new Map(state.assets);
    for (const prev of state.manifest.stickers) {
      nextAssets.delete(prev.file);
    }
    nextAssets.set(file, new Uint8Array(bytes));

    // A sound taken from the previous video belongs to that video, not to the new sticker.
    let existingAudio = state.manifest.audios[0];
    if (existingAudio?.source.type === "video-track") {
      nextAssets.delete(existingAudio.file);
      existingAudio = undefined;
    }
    const maxAudioMs = this.resolveEffectiveMaxAudioMs(
      EXPORT_PROFILES[state.manifest.export.profile].maxAudioMs,
      maxAudioMsOverride
    );
    const gifMinMs = this.resolveGifMinDurationMs(sticker, maxAudioMs);
    const prevAssoc = existingAudio ? state.manifest.associations[0] : undefined;
    let assocStartMs = prevAssoc?.start_ms ?? 0;
    let assocEndMs = prevAssoc?.end_ms ?? (existingAudio ? Math.min(existingAudio.duration_ms, maxAudioMs) : 0);
    if (existingAudio) {
      const targetMinWindow = Math.min(existingAudio.duration_ms, gifMinMs);
      if (assocEndMs - assocStartMs < targetMinWindow) {
        assocEndMs = Math.min(existingAudio.duration_ms, assocStartMs + targetMinWindow);
        if (assocEndMs - assocStartMs < targetMinWindow) {
          assocStartMs = Math.max(0, assocEndMs - targetMinWindow);
        }
      }
    }
    const nextAssociations: Association[] = existingAudio
      ? [
          {
            id: prevAssoc?.id ?? generateAssetId("asc"),
            sticker_id: sticker.id,
            audio_id: existingAudio.id,
            start_ms: assocStartMs,
            end_ms: assocEndMs,
            volume: prevAssoc?.volume ?? 1,
            fade_in_ms: prevAssoc?.fade_in_ms ?? 0,
            fade_out_ms: prevAssoc?.fade_out_ms ?? 0
          }
        ]
      : [];

    const withSticker: ProjectWorkspaceState = {
      manifest: {
        ...state.manifest,
        project: { ...state.manifest.project, updated_at: nowUtcIso() },
        stickers: [sticker],
        audios: existingAudio ? [existingAudio] : [],
        associations: nextAssociations,
        active_association_id: nextAssociations[0]?.id ?? null
      },
      assets: nextAssets,
      waveformPeaks: existingAudio ? state.waveformPeaks : null
    };

    // Video: its own sound becomes the audio by default (the user can still pick another one).
    // Its trim window then also chooses which part of the clip is rendered.
    if (isVideo && this.engine.extractAudioTrack) {
      const track = await this.engine.extractAudioTrack(bytes, probe.duration_ms);
      return this.importAudioFile(
        withSticker,
        track.wavBytes,
        track.silent ? "Video sin sonido" : "Sonido del video",
        { type: "video-track" },
        maxAudioMsOverride
      );
    }
    return withSticker;
  }

  private resolveEffectiveMaxAudioMs(profileMaxMs: number, overrideMaxMs?: number): number {
    if (overrideMaxMs === undefined || !Number.isFinite(overrideMaxMs)) {
      return profileMaxMs;
    }
    return Math.max(LIMITS.MIN_TRIM_DURATION_MS, Math.min(Math.round(overrideMaxMs), profileMaxMs));
  }

  private resolveGifMinDurationMs(sticker: StickerAsset | undefined, maxAudioMs: number): number {
    if (sticker && sticker.format === "gif" && sticker.animated && (sticker.duration_ms ?? 0) > 0) {
      return Math.max(LIMITS.MIN_TRIM_DURATION_MS, Math.min(Math.round(sticker.duration_ms!), maxAudioMs));
    }
    return LIMITS.MIN_TRIM_DURATION_MS;
  }

  public async importAudioFile(
    state: ProjectWorkspaceState,
    bytes: Uint8Array,
    sourceName: string,
    source: AudioSource = { type: "local" },
    maxAudioMsOverride?: number
  ): Promise<ProjectWorkspaceState> {
    if (bytes.byteLength === 0) {
      throw new StikSoundError("unsupported-audio", "Empty audio payload.");
    }
    if (bytes.byteLength > LIMITS.MAX_AUDIO_BYTES) {
      throw new StikSoundError("file-too-large", "Audio exceeds 25 MB limit.");
    }

    const probe = await this.engine.probeAudio(bytes);
    if (probe.duration_ms > LIMITS.MAX_AUDIO_DURATION_MS) {
      throw new StikSoundError("file-too-large", "Audio exceeds 3 minute editing limit.");
    }
    if (probe.duration_ms < LIMITS.MIN_AUDIO_DURATION_MS) {
      throw new StikSoundError("unsupported-audio", "Audio is shorter than 100 ms.");
    }

    const peaks = await this.engine.waveform(bytes);
    const id = generateAssetId("aud");
    const file = `assets/${id}.${probe.format}`;
    const audio: AudioAsset = {
      id,
      file,
      source_name: sourceName.slice(0, 255) || `${id}.${probe.format}`,
      format: probe.format,
      duration_ms: probe.duration_ms,
      sample_rate: probe.sample_rate,
      channels: probe.channels,
      source
    };

    const nextAssets = new Map(state.assets);
    for (const prev of state.manifest.audios) {
      nextAssets.delete(prev.file);
    }
    nextAssets.set(file, new Uint8Array(bytes));

    const maxAudioMs = this.resolveEffectiveMaxAudioMs(
      EXPORT_PROFILES[state.manifest.export.profile].maxAudioMs,
      maxAudioMsOverride
    );
    const defaultTrim = defaultTrimForDuration(audio.duration_ms, maxAudioMs);
    const existingSticker = state.manifest.stickers[0];
    const nextAssociations: Association[] = existingSticker
      ? [
          {
            id: generateAssetId("asc"),
            sticker_id: existingSticker.id,
            audio_id: audio.id,
            ...defaultTrim
          }
        ]
      : [];

    return {
      manifest: {
        ...state.manifest,
        project: { ...state.manifest.project, updated_at: nowUtcIso() },
        audios: [audio],
        associations: nextAssociations,
        active_association_id: nextAssociations[0]?.id ?? null
      },
      assets: nextAssets,
      waveformPeaks: peaks
    };
  }

  public async importAudioUrl(
    state: ProjectWorkspaceState,
    rawUrl: string,
    maxAudioMsOverride?: number
  ): Promise<ProjectWorkspaceState> {
    const provider = this.providers.find((p) => p.canResolve(rawUrl));
    if (!provider) {
      throw new StikSoundError("url-rejected", `No allowlisted provider handles URL: ${rawUrl}`);
    }
    const resolved = await provider.resolve(rawUrl);
    const sourceName = resolved.title ?? resolved.media_url.split("/").pop() ?? "sound.mp3";
    return this.importAudioFile(
      state,
      resolved.bytes,
      sourceName,
      {
        type: "myinstants",
        page_url: resolved.page_url,
        media_url: resolved.media_url,
        title: resolved.title
      },
      maxAudioMsOverride
    );
  }

  public updateAudioEdit(
    state: ProjectWorkspaceState,
    patch: Partial<{ start_ms: number; end_ms: number; volume: number; fade_in_ms: number; fade_out_ms: number }>,
    maxAudioMsOverride?: number
  ): ProjectWorkspaceState {
    const audio = state.manifest.audios[0];
    const current = state.manifest.associations[0];
    if (!audio || !current) {
      return state;
    }

    const updated: Association = {
      ...current,
      start_ms: patch.start_ms ?? current.start_ms,
      end_ms: patch.end_ms ?? current.end_ms,
      volume: clampVolume(patch.volume ?? current.volume),
      fade_in_ms: patch.fade_in_ms ?? current.fade_in_ms,
      fade_out_ms: patch.fade_out_ms ?? current.fade_out_ms
    };

    const maxAudioMs = this.resolveEffectiveMaxAudioMs(
      EXPORT_PROFILES[state.manifest.export.profile].maxAudioMs,
      maxAudioMsOverride
    );
    const gifMinMs = this.resolveGifMinDurationMs(state.manifest.stickers[0], maxAudioMs);
    validateAudioTrim(updated, audio.duration_ms, maxAudioMs, gifMinMs);

    return {
      ...state,
      manifest: {
        ...state.manifest,
        project: { ...state.manifest.project, updated_at: nowUtcIso() },
        associations: [updated]
      }
    };
  }

  public updateStickerEdit(state: ProjectWorkspaceState, patch: Partial<StickerEdit>): ProjectWorkspaceState {
    const sticker = state.manifest.stickers[0];
    if (!sticker) return state;

    const nextSticker: StickerAsset = {
      ...sticker,
      edit: {
        ...sticker.edit,
        ...patch,
        fit: "contain"
      }
    };

    return {
      ...state,
      manifest: {
        ...state.manifest,
        project: { ...state.manifest.project, updated_at: nowUtcIso() },
        stickers: [nextSticker]
      }
    };
  }

  public associate(
    state: ProjectWorkspaceState,
    stickerId: string,
    audioId: string,
    maxAudioMsOverride?: number
  ): ProjectWorkspaceState {
    const sticker = state.manifest.stickers.find((s) => s.id === stickerId);
    const audio = state.manifest.audios.find((a) => a.id === audioId);
    if (!sticker || !audio) {
      throw new StikSoundError("package-invalid", "Cannot associate missing sticker or audio.");
    }
    const maxAudioMs = this.resolveEffectiveMaxAudioMs(
      EXPORT_PROFILES[state.manifest.export.profile].maxAudioMs,
      maxAudioMsOverride
    );
    const defaultTrim = defaultTrimForDuration(audio.duration_ms, maxAudioMs);
    const assoc: Association = {
      id: generateAssetId("asc"),
      sticker_id: sticker.id,
      audio_id: audio.id,
      ...defaultTrim
    };

    return {
      ...state,
      manifest: {
        ...state.manifest,
        project: { ...state.manifest.project, updated_at: nowUtcIso() },
        associations: [assoc],
        active_association_id: assoc.id
      }
    };
  }

  public setExportProfile(state: ProjectWorkspaceState, profile: ExportProfileId): ProjectWorkspaceState {
    return {
      ...state,
      manifest: {
        ...state.manifest,
        project: { ...state.manifest.project, updated_at: nowUtcIso() },
        export: {
          profile,
          target: "whatsapp"
        }
      }
    };
  }

  public renameProject(state: ProjectWorkspaceState, name: string): ProjectWorkspaceState {
    const clean = name.trim().slice(0, 80);
    if (!clean) return state;
    return {
      ...state,
      manifest: {
        ...state.manifest,
        project: {
          ...state.manifest.project,
          name: clean,
          updated_at: nowUtcIso()
        }
      }
    };
  }

  public async saveProject(state: ProjectWorkspaceState): Promise<Uint8Array> {
    validateProjectManifest(state.manifest);
    const encoder = new TextEncoder();
    const manifestBytes = encoder.encode(JSON.stringify(state.manifest, null, 2));
    const entries: ZipEntryInput[] = [{ path: "manifest.json", bytes: manifestBytes }];

    for (const sticker of state.manifest.stickers) {
      const data = state.assets.get(sticker.file);
      if (!data) throw new StikSoundError("package-invalid", `Missing sticker bytes: ${sticker.file}`);
      entries.push({ path: sticker.file, bytes: data });
    }
    for (const audio of state.manifest.audios) {
      const data = state.assets.get(audio.file);
      if (!data) throw new StikSoundError("package-invalid", `Missing audio bytes: ${audio.file}`);
      entries.push({ path: audio.file, bytes: data });
    }

    return this.engine.zip(entries);
  }

  public async openProject(zipBytes: Uint8Array): Promise<ProjectWorkspaceState> {
    const entries = await this.engine.unzip(zipBytes);
    if (entries.length > LIMITS.MAX_PACKAGE_FILES) {
      throw new StikSoundError("package-invalid", "Too many files inside package.");
    }

    let totalUncompressed = 0;
    const byPath = new Map<string, Uint8Array>();
    for (const entry of entries) {
      assertSafeZipEntryPath(entry.path);
      totalUncompressed += entry.bytes.byteLength;
      if (totalUncompressed > LIMITS.MAX_PACKAGE_BYTES) {
        throw new StikSoundError("package-invalid", "Package exceeds 100 MB uncompressed limit.");
      }
      byPath.set(entry.path, entry.bytes);
    }

    const manifestRaw = byPath.get("manifest.json");
    if (!manifestRaw) {
      throw new StikSoundError("package-invalid", "Package is missing manifest.json.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(manifestRaw));
    } catch {
      throw new StikSoundError("package-invalid", "Invalid JSON in manifest.json.");
    }

    const manifest = validateProjectManifest(parsed);
    const assets = new Map<string, Uint8Array>();

    for (const sticker of manifest.stickers) {
      const bytes = byPath.get(sticker.file);
      if (!bytes) throw new StikSoundError("package-invalid", `Missing referenced sticker: ${sticker.file}`);
      assets.set(sticker.file, bytes);
    }
    for (const audio of manifest.audios) {
      const bytes = byPath.get(audio.file);
      if (!bytes) throw new StikSoundError("package-invalid", `Missing referenced audio: ${audio.file}`);
      assets.set(audio.file, bytes);
    }

    let peaks: PeakBuckets | null = null;
    const firstAudio = manifest.audios[0];
    if (firstAudio) {
      const audioBytes = assets.get(firstAudio.file);
      if (audioBytes) {
        peaks = await this.engine.waveform(audioBytes);
      }
    }

    return {
      manifest,
      assets,
      waveformPeaks: peaks
    };
  }

  public async exportProject(
    state: ProjectWorkspaceState,
    overrideProfile?: ExportProfileId,
    maxAudioMsOverride?: number
  ): Promise<ExportArtifact> {
    const profileId = overrideProfile ?? state.manifest.export.profile;
    if (profileId === "native-sound-sticker") {
      throw new StikSoundError("export-unsupported", "Native WhatsApp sound sticker export is disabled.");
    }

    validateProjectManifest(state.manifest);
    const profile = EXPORT_PROFILES[profileId];
    const sticker = state.manifest.stickers[0];
    if (!sticker) {
      throw new StikSoundError("unsupported-image", "No sticker loaded to export.");
    }
    const stickerBytes = state.assets.get(sticker.file);
    if (!stickerBytes) {
      throw new StikSoundError("package-invalid", "Sticker asset missing from workspace.");
    }

    const safeName = sanitizeExportName(state.manifest.project.name);

    if (profileId === "standard-webp") {
      if (sticker.animated) {
        throw new StikSoundError("unsupported-image", "Static WebP export does not support animated stickers yet.");
      }
      const frame = await this.engine.renderSticker(stickerBytes, sticker.edit);
      const webpBytes = await this.engine.encodeWebp(frame);
      if (webpBytes.byteLength > LIMITS.MAX_STATIC_WEBP_BYTES) {
        throw new StikSoundError("sticker-too-large", "Encoded WebP exceeds 100 KB.");
      }
      return {
        profile: "standard-webp",
        fileName: `${safeName}-sticker.webp`,
        mimeType: "image/webp",
        bytes: webpBytes
      };
    }

    // Profiles requiring audio + association
    const audio = state.manifest.audios[0];
    const assoc = state.manifest.associations[0];
    if (!audio || !assoc) {
      throw new StikSoundError("unsupported-audio", "Attach an audio clip before exporting.");
    }
    const audioBytes = state.assets.get(audio.file);
    if (!audioBytes) {
      throw new StikSoundError("package-invalid", "Audio asset missing from workspace.");
    }

    const maxAudioMs = this.resolveEffectiveMaxAudioMs(profile.maxAudioMs, maxAudioMsOverride);
    const gifMinMs = this.resolveGifMinDurationMs(sticker, maxAudioMs);
    validateAudioTrim(assoc, audio.duration_ms, maxAudioMs, gifMinMs);
    const expectedTrimDurationMs = assoc.end_ms - assoc.start_ms;

    if (profileId === "sound-bundle") {
      const frame = await this.engine.renderSticker(stickerBytes, sticker.edit);
      const webpBytes = await this.engine.encodeWebp(frame);
      if (webpBytes.byteLength > LIMITS.MAX_STATIC_WEBP_BYTES) {
        throw new StikSoundError("sticker-too-large", "Encoded WebP exceeds 100 KB.");
      }
      const pcm = await this.engine.renderAudio(audioBytes, {
        start_ms: assoc.start_ms,
        end_ms: assoc.end_ms,
        volume: assoc.volume
      });
      if (Math.abs(pcm.durationMs - expectedTrimDurationMs) > LIMITS.DURATION_TOLERANCE_MS) {
        throw new StikSoundError("encode-failed", "Trimmed audio duration outside 50 ms tolerance.");
      }
      const opusBytes = await this.engine.encodeOpus(pcm);

      const bundleManifest: ProjectManifest = {
        ...state.manifest,
        bundle: {
          kind: "sound-bundle",
          created_at: nowUtcIso(),
          files: {
            sticker: "sticker.webp",
            audio: "sound.ogg"
          },
          audio_encoding: {
            container: "ogg",
            codec: "opus",
            channels: 1,
            sample_rate: 48000,
            bitrate_bps: 64000
          },
          limits: {
            sticker_px: 512,
            max_static_bytes: 102400,
            max_audio_ms: maxAudioMs
          },
          whatsapp_native: false
        }
      };
      validateProjectManifest(bundleManifest);

      const zipBytes = await this.engine.zip([
        { path: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(bundleManifest, null, 2)) },
        { path: "sticker.webp", bytes: webpBytes },
        { path: "sound.ogg", bytes: opusBytes }
      ]);

      return {
        profile: "sound-bundle",
        fileName: `${safeName}-stiksound.zip`,
        mimeType: "application/zip",
        bytes: zipBytes,
        durationMs: pcm.durationMs
      };
    }

    const expectedDurationMs = Math.min(maxAudioMs, Math.max(expectedTrimDurationMs, gifMinMs));

    // video-mp4 or video-webm-alpha (primary 10-second video flow)
    const videoResult = await this.engine.renderVideo({
      stickerBytes,
      stickerFormat: sticker.format,
      animated: sticker.animated,
      stickerWidth: sticker.width,
      stickerHeight: sticker.height,
      // Sound from the clip itself: render the same part of the clip. Other sound: clip from its start.
      videoOffsetMs: audio.source.type === "video-track" ? assoc.start_ms : 0,
      minDurationMs: expectedDurationMs,
      audioBytes,
      audioFormat: audio.format,
      startMs: assoc.start_ms,
      endMs: assoc.end_ms,
      volume: assoc.volume,
      matteColor: sticker.edit.matte_color ?? LIMITS.DEFAULT_MATTE_COLOR,
      cropX: sticker.edit.crop_x ?? 0.5,
      cropY: sticker.edit.crop_y ?? 0.5,
      cropZoom: sticker.edit.scale ?? 1,
      container: profileId === "video-webm-alpha" ? "webm-alpha" : "mp4"
    });

    if (Math.abs(videoResult.durationMs - expectedDurationMs) > LIMITS.DURATION_TOLERANCE_MS) {
      throw new StikSoundError("encode-failed", "Rendered video duration outside 50 ms tolerance.");
    }

    const durationSuffix = `${Math.round(maxAudioMs / 1000)}s`;
    return {
      profile: profileId,
      fileName: `${safeName}-${durationSuffix}.${videoResult.extension}`,
      mimeType: videoResult.mimeType,
      bytes: videoResult.bytes,
      durationMs: videoResult.durationMs
    };
  }
}
