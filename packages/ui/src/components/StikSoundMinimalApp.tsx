/// <reference path="../assets.d.ts" />
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconArrow, IconClose, IconDownload, IconMore, IconSpinner } from "./icons";
import {
  EXPORT_PROFILES,
  LIMITS,
  LOCALE_NATIVE_NAMES,
  ProjectController,
  SUPPORTED_LOCALES,
  computeSquareCrop,
  clampCropZoom,
  CROP_ZOOM_MAX,
  CROP_ZOOM_MIN,
  createProject,
  formatError,
  isVideoFormat,
  resetProject,
  stickerMimeType,
  type ExportArtifact,
  type ExportProfileId,
  type LocaleCode,
  type MediaEngine,
  type ProjectWorkspaceState,
  type SoundProvider
} from "@stiksound/core";
import arLocale from "../locales/ar.json";
import deLocale from "../locales/de.json";
import enLocale from "../locales/en.json";
import esLocale from "../locales/es.json";
import frLocale from "../locales/fr.json";
import itLocale from "../locales/it.json";
import ptLocale from "../locales/pt.json";
import ruLocale from "../locales/ru.json";
import zhLocale from "../locales/zh.json";
import { TimelineTrimBar } from "./TimelineTrimBar";
import { SoundBrowser, type SoundSearchFn } from "./SoundBrowser";
import { GifBrowser, type GifSearchResult, type GifSource } from "./GifBrowser";
import { MAX_RECORDING_MS, canRecordAudio, startRecording, type ActiveRecording } from "./recording";
import { Tour, hasSeenTour, markTourSeen } from "./Tour";
import waSoundButtonImg from "../assets/wa-editor-sound-button.png";
import waBecomeTesterImg from "../assets/wa-become-tester.png";

export type ShareOutcome = "shared" | "cancelled" | "needs-tap";

export interface ShellBridge {
  saveArtifact(artifact: ExportArtifact): Promise<string | void>;
  copyArtifactToClipboard?(artifact: ExportArtifact): Promise<void>;
  /**
   * Mobile web: hand the video to the OS share sheet (WhatsApp, Save Video, Files).
   * Return "needs-tap" when the browser refused because the user gesture expired.
   */
  shareArtifact?(artifact: ExportArtifact): Promise<ShareOutcome>;
}

export interface PlatformOptions {
  /** Offer transparent WebM output. Mobile Safari cannot encode it. Default true. */
  transparentVideo?: boolean;
  /** Show the MyInstants URL field. Plain web pages are blocked by CORS. Default true. */
  myInstantsUrl?: boolean;
  /** Offer short video clips (MP4/MOV/WebM) in the sticker picker. Needs the web media engine. Default false. */
  videoStickers?: boolean;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif";
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm";

export type UiLabels = typeof esLocale;

export interface StikSoundMinimalAppProps {
  engine: MediaEngine;
  providers?: SoundProvider[];
  shell: ShellBridge;
  initialLocale?: LocaleCode;
  initialState?: ProjectWorkspaceState;
  platform?: PlatformOptions;
  labelOverrides?: Partial<Record<LocaleCode, Partial<UiLabels>>>;
  appVersion?: string;
  /** When set, shows a MyInstants browser; picked sounds go through the URL import (providers). */
  soundSearch?: SoundSearchFn;
  /** When set, shows a GIF search (Tenor) on the empty sticker area. */
  gifSource?: GifSource;
  /** Open the "how to use" tour on the first visit (remembered in localStorage). Always in the ⋯ menu. */
  showTourOnFirstVisit?: boolean;
}

const REPO_URL = "https://github.com/hweg000/stickerslive";
// MIT/Apache-2.0 require keeping the original copyright notice in copies of this fork.
const ORIGINAL_REPO_URL = "https://github.com/SilverFeit/StikSound";

const LOCALES: Record<LocaleCode, UiLabels> = {
  es: esLocale,
  en: enLocale,
  pt: ptLocale,
  fr: frLocale,
  de: deLocale,
  it: itLocale,
  ru: ruLocale,
  zh: zhLocale,
  ar: arLocale
};

function audioMimeType(format: string): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    default:
      return "audio/mpeg";
  }
}

export const StikSoundMinimalApp: React.FC<StikSoundMinimalAppProps> = ({
  engine,
  providers = [],
  shell,
  initialLocale = "es",
  initialState,
  platform,
  labelOverrides,
  appVersion = "1.1.2",
  soundSearch,
  gifSource,
  showTourOnFirstVisit = false
}) => {
  const allowTransparent = platform?.transparentVideo !== false;
  const allowMyInstantsUrl = platform?.myInstantsUrl !== false;
  const allowVideoStickers = platform?.videoStickers === true;
  const controller = useMemo(() => new ProjectController(engine, providers), [engine, providers]);
  const [locale, setLocale] = useState<LocaleCode>(initialLocale);
  const [project, setProject] = useState<ProjectWorkspaceState>(() => initialState ?? createProject());
  const [urlInput, setUrlInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [gifBrowserOpen, setGifBrowserOpen] = useState(false);
  // "Change sound": shows the sound sources again while the current sound stays loaded until replaced.
  const [changingAudio, setChangingAudio] = useState(false);
  const [tourOpen, setTourOpen] = useState(() => showTourOnFirstVisit && !hasSeenTour());
  const closeTour = useCallback(() => {
    markTourSeen();
    setTourOpen(false);
  }, []);
  const [waGuideOpen, setWaGuideOpen] = useState(false);
  const closeWaGuide = useCallback(() => setWaGuideOpen(false), []);
  const [readyArtifact, setReadyArtifact] = useState<ExportArtifact | null>(null);
  const [maxDurationMs, setMaxDurationMs] = useState<5000 | 10000>(10_000);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const stickerFileInputRef = useRef<HTMLInputElement>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const playbackTimerRef = useRef<number | null>(null);

  const copy: UiLabels = useMemo(
    () => ({ ...LOCALES[locale], ...labelOverrides?.[locale] }),
    [locale, labelOverrides]
  );
  const sticker = project.manifest.stickers[0];
  const audio = project.manifest.audios[0];
  const assoc = project.manifest.associations[0];
  const activeProfile = project.manifest.export.profile;
  const profileDef = EXPORT_PROFILES[activeProfile];
  const effectiveMaxAudioMs = profileDef.requiresAudio
    ? Math.min(maxDurationMs, profileDef.maxAudioMs)
    : maxDurationMs;
  const stickerIsVideo = Boolean(sticker) && isVideoFormat(sticker!.format);
  // Sound taken from the clip itself: the trim window also picks which part of the clip is used.
  const audioFromVideo = audio?.source.type === "video-track";
  const videoOffsetMs = stickerIsVideo && audioFromVideo ? assoc?.start_ms ?? 0 : 0;

  const stickerFile = sticker?.file;
  const stickerFormat = sticker?.format;
  const stickerPreviewUrl = useMemo(() => {
    if (!stickerFile || !stickerFormat) return null;
    const bytes = project.assets.get(stickerFile);
    if (!bytes || typeof URL.createObjectURL !== "function") return null;
    const blob = new Blob([bytes.slice().buffer], { type: stickerMimeType(stickerFormat) });
    return URL.createObjectURL(blob);
  }, [stickerFile, stickerFormat, project.assets]);

  // Keep the looping preview clip on the chosen 5 s window.
  useEffect(() => {
    const el = previewVideoRef.current;
    if (!el || !stickerIsVideo) return;
    const startSec = videoOffsetMs / 1000;
    const endSec = startSec + Math.max(0.1, ((assoc?.end_ms ?? 0) - (assoc?.start_ms ?? 0)) / 1000 || 5);
    const onTime = () => {
      if (el.currentTime < startSec - 0.05 || el.currentTime >= endSec) el.currentTime = startSec;
    };
    el.currentTime = startSec;
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [stickerIsVideo, videoOffsetMs, assoc?.start_ms, assoc?.end_ms, stickerPreviewUrl]);

  const readyVideoUrl = useMemo(() => {
    if (!readyArtifact || typeof URL.createObjectURL !== "function") return null;
    const blob = new Blob([readyArtifact.bytes.slice().buffer], { type: readyArtifact.mimeType });
    return URL.createObjectURL(blob);
  }, [readyArtifact]);

  useEffect(() => {
    return () => {
      if (stickerPreviewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(stickerPreviewUrl);
      }
    };
  }, [stickerPreviewUrl]);

  useEffect(() => {
    return () => {
      if (readyVideoUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(readyVideoUrl);
      }
    };
  }, [readyVideoUrl]);

  const stopPlayback = useCallback(() => {
    if (playbackTimerRef.current !== null) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
      audioElRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => stopPlayback, [stopPlayback]);

  const handleError = useCallback(
    (err: unknown) => {
      const localized = formatError(err, locale);
      setErrorMessage(`${localized.title} ${localized.action}`);
      setStatusMessage(null);
    },
    [locale]
  );

  const importStickerBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      setIsBusy(true);
      setErrorMessage(null);
      setStatusMessage(null);
      setReadyArtifact(null);
      setDownloadMenuOpen(false);
      try {
        const next = await controller.importSticker(project, bytes, name, effectiveMaxAudioMs);
        setProject(next);
        const nextAudio = next.manifest.audios[0];
        const peaks = next.waveformPeaks;
        if (nextAudio?.source.type === "video-track" && peaks && peaks.maxs.every((v) => v === 0)) {
          setStatusMessage(copy.videoSilentToast);
        }
      } catch (err) {
        handleError(err);
      } finally {
        setIsBusy(false);
      }
    },
    [controller, project, effectiveMaxAudioMs, handleError, copy]
  );

  const importAudioBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      stopPlayback();
      setIsBusy(true);
      setErrorMessage(null);
      setStatusMessage(null);
      setReadyArtifact(null);
      setDownloadMenuOpen(false);
      try {
        const next = await controller.importAudioFile(
          project,
          bytes,
          name,
          { type: "local" },
          effectiveMaxAudioMs
        );
        setProject(next);
        setChangingAudio(false);
      } catch (err) {
        handleError(err);
      } finally {
        setIsBusy(false);
      }
    },
    [controller, project, effectiveMaxAudioMs, handleError, stopPlayback]
  );

  const importGif = useCallback(
    async (gif: GifSearchResult) => {
      if (!gifSource) return;
      setGifBrowserOpen(false);
      setIsBusy(true);
      let bytes: Uint8Array;
      try {
        bytes = await gifSource.download(gif);
      } catch (err) {
        handleError(err);
        setIsBusy(false);
        return;
      }
      await importStickerBytes(bytes, gif.gif_url.split("/").pop() || "tenor.gif");
    },
    [gifSource, handleError, importStickerBytes]
  );

  const importMyInstantsUrl = useCallback(
    async (rawUrl: string) => {
      stopPlayback();
      setIsBusy(true);
      setErrorMessage(null);
      setStatusMessage(null);
      setReadyArtifact(null);
      setDownloadMenuOpen(false);
      try {
        const next = await controller.importAudioUrl(project, rawUrl, effectiveMaxAudioMs);
        setProject(next);
        setUrlInput("");
        setChangingAudio(false);
      } catch (err) {
        handleError(err);
      } finally {
        setIsBusy(false);
      }
    },
    [controller, project, effectiveMaxAudioMs, handleError, stopPlayback]
  );

  // Microphone recording: the take is converted to WAV and goes through the normal audio import.
  const recordAvailable = useMemo(() => canRecordAudio(), []);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [recordingNow, setRecordingNow] = useState(0);
  const stopRecording = async () => {
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    setRecordingSince(null);
    let bytes: Uint8Array;
    setIsBusy(true);
    try {
      bytes = await rec.stop();
    } catch {
      setIsBusy(false);
      setErrorMessage(copy.recordError);
      return;
    }
    setIsBusy(false);
    await importAudioBytes(bytes, "grabacion.wav");
  };
  const toggleRecording = async () => {
    if (recordingRef.current) return stopRecording();
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      recordingRef.current = await startRecording();
      const now = Date.now();
      setRecordingSince(now);
      setRecordingNow(now);
    } catch {
      setErrorMessage(copy.recordError); // permission denied or no microphone
    }
  };
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;
  useEffect(() => {
    if (recordingSince === null) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setRecordingNow(now);
      if (now - recordingSince >= MAX_RECORDING_MS) void stopRecordingRef.current();
    }, 200);
    return () => window.clearInterval(id);
  }, [recordingSince]);
  useEffect(() => () => recordingRef.current?.cancel(), []);

  const handleGlobalPaste = useCallback(
    async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const candidates: Array<{ file: File; rank: number }> = [];
      const rankImage = (mime: string, name: string): number => {
        const m = mime.toLowerCase();
        const n = name.toLowerCase();
        if (m === "image/gif" || n.endsWith(".gif")) return 3;
        if (m === "image/webp" || n.endsWith(".webp")) return 2;
        return 1;
      };

      const files = e.clipboardData?.files;
      if (files) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          if (f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(f.name)) {
            candidates.push({ file: f, rank: rankImage(f.type, f.name) });
          }
        }
      }

      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              candidates.push({ file, rank: rankImage(item.type || file.type, file.name) });
            }
          }
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.rank - a.rank);
        const best = candidates[0]!.file;
        e.preventDefault();
        await importStickerBytes(new Uint8Array(await best.arrayBuffer()), best.name || "pasted.png");
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (allowMyInstantsUrl && text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        setUrlInput(text);
        await importMyInstantsUrl(text);
      }
    },
    [importStickerBytes, importMyInstantsUrl, allowMyInstantsUrl]
  );

  useEffect(() => {
    window.addEventListener("paste", handleGlobalPaste);
    return () => window.removeEventListener("paste", handleGlobalPaste);
  }, [handleGlobalPaste]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    if (!audio || !assoc) return;
    const bytes = project.assets.get(audio.file);
    if (!bytes || typeof Audio === "undefined" || typeof URL.createObjectURL !== "function") return;

    const blob = new Blob([bytes.slice().buffer], { type: audioMimeType(audio.format) });
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    el.currentTime = assoc.start_ms / 1000;
    audioElRef.current = el;
    setIsPlaying(true);
    // Restart the (muted) preview clip so picture and sound line up.
    if (previewVideoRef.current) {
      previewVideoRef.current.currentTime = videoOffsetMs / 1000;
      previewVideoRef.current.play().catch(() => undefined);
    }

    const playDur = Math.max(100, assoc.end_ms - assoc.start_ms);
    playbackTimerRef.current = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      stopPlayback();
    }, playDur);

    el.play().catch(() => {
      URL.revokeObjectURL(url);
      stopPlayback();
    });
  }, [isPlaying, stopPlayback, audio, assoc, project.assets, videoOffsetMs]);

  const handleResetAll = () => {
    stopPlayback();
    setChangingAudio(false);
    setProject((prev) => resetProject(prev));
    setReadyArtifact(null);
    setDownloadMenuOpen(false);
    setMenuOpen(false);
    setUrlInput("");
    setErrorMessage(null);
    setStatusMessage(null);
  };

  const minRequiredTrimMs =
    sticker && sticker.format === "gif" && sticker.animated && (sticker.duration_ms ?? 0) > 0 && audio
      ? Math.max(LIMITS.MIN_TRIM_DURATION_MS, Math.min(audio.duration_ms, sticker.duration_ms!, effectiveMaxAudioMs))
      : LIMITS.MIN_TRIM_DURATION_MS;
  const trimValid =
    !profileDef.requiresAudio ||
    (assoc !== undefined &&
      assoc.end_ms - assoc.start_ms >= minRequiredTrimMs &&
      assoc.end_ms - assoc.start_ms <= effectiveMaxAudioMs);
  const canExport = Boolean(sticker) && (!profileDef.requiresAudio || Boolean(audio)) && trimValid && !isBusy;

  let exportDisabledReason = copy.exportTooltip;
  if (!sticker) exportDisabledReason = copy.exportDisabledMissingSticker;
  else if (profileDef.requiresAudio && !audio) exportDisabledReason = copy.exportDisabledMissingAudio;
  else if (!trimValid) {
    exportDisabledReason = copy.exportDisabledTrim.replace("10.0", (effectiveMaxAudioMs / 1000).toFixed(1));
  }

  const copyArtifactNow = async (artifact: ExportArtifact) => {
    if (shell.shareArtifact) {
      const outcome = await shell.shareArtifact(artifact);
      setStatusMessage(outcome === "needs-tap" ? copy.shareReadyToast : null);
      return;
    }
    if (shell.copyArtifactToClipboard) {
      await shell.copyArtifactToClipboard(artifact);
      setStatusMessage(copy.copiedReadyToast);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      try {
        const blob = new Blob([artifact.bytes.slice().buffer], { type: artifact.mimeType });
        await navigator.clipboard.write([new ClipboardItem({ [artifact.mimeType]: blob })]);
      } catch {
        // Fallback if browser restricts video MIME in ClipboardItem
      }
    }
    setStatusMessage(copy.copiedReadyToast);
  };

  // Arrow (➔): encodes the current video and copies it. Pasting it in a chat sends a video, not a sticker.
  const handlePreviewAndCopyArrow = async () => {
    if (!canExport) return;
    stopPlayback();
    setDownloadMenuOpen(false);
    setMenuOpen(false);
    setIsBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const compatibleProfile: ExportProfileId =
        activeProfile === "video-webm-alpha" && allowTransparent ? "video-webm-alpha" : "video-mp4";
      const artifact =
        readyArtifact ?? (await controller.exportProject(project, compatibleProfile, maxDurationMs));
      setReadyArtifact(artifact);
      await copyArtifactNow(artifact);
    } catch (err) {
      handleError(err);
    } finally {
      setIsBusy(false);
    }
  };

  // Download format selection (⬇): exports the chosen format & saves to disk
  const handleDownloadWithFormat = async (formatProfile: ExportProfileId) => {
    if (!sticker || isBusy) return;
    const def = EXPORT_PROFILES[formatProfile];
    if (def.requiresAudio && (!audio || !trimValid)) return;

    stopPlayback();
    setDownloadMenuOpen(false);
    setMenuOpen(false);
    setIsBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const artifact = await controller.exportProject(project, formatProfile, maxDurationMs);
      await shell.saveArtifact(artifact);
      setStatusMessage(
        artifact.profile === "sound-bundle"
          ? copy.exportSuccessBundle
          : artifact.profile === "standard-webp"
            ? copy.exportSuccessWebp
            : copy.exportSuccessVideo
      );
    } catch (err) {
      handleError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleRangeChange = (startMs: number, endMs: number) => {
    setReadyArtifact(null);
    try {
      setProject((prev) =>
        controller.updateAudioEdit(prev, { start_ms: startMs, end_ms: endMs }, effectiveMaxAudioMs)
      );
      setErrorMessage(null);
    } catch (err) {
      handleError(err);
    }
  };

  const handleMaxDurationChange = (nextMax: 5000 | 10000) => {
    if (nextMax === maxDurationMs) return;
    stopPlayback();
    setReadyArtifact(null);
    setMaxDurationMs(nextMax);
    setErrorMessage(null);
    if (audio && assoc) {
      const selected = assoc.end_ms - assoc.start_ms;
      if (nextMax < selected) {
        const nextEnd = Math.min(audio.duration_ms, assoc.start_ms + nextMax);
        setProject((prev) =>
          controller.updateAudioEdit(prev, { start_ms: assoc.start_ms, end_ms: nextEnd }, nextMax)
        );
      } else if (nextMax === 10_000 && selected === 5_000 && audio.duration_ms > 5_000) {
        const targetWindow = Math.min(nextMax, audio.duration_ms);
        const nextStart = Math.max(0, Math.min(assoc.start_ms, audio.duration_ms - targetWindow));
        setProject((prev) =>
          controller.updateAudioEdit(
            prev,
            { start_ms: nextStart, end_ms: nextStart + targetWindow },
            nextMax
          )
        );
      }
    }
  };

  const selectTransparentMode = () => {
    setReadyArtifact(null);
    setProject((prev) => controller.setExportProfile(prev, "video-webm-alpha"));
  };

  const selectSolidMatte = (hex: string) => {
    setReadyArtifact(null);
    setProject((prev) => {
      const withProfile = controller.setExportProfile(prev, "video-mp4");
      return controller.updateStickerEdit(withProfile, { matte_color: hex });
    });
  };

  const isTransparentSelected = allowTransparent && activeProfile === "video-webm-alpha";
  const currentMatte = sticker?.edit.matte_color ?? LIMITS.DEFAULT_MATTE_COLOR;
  const cropX = sticker?.edit.crop_x ?? 0.5;
  const cropY = sticker?.edit.crop_y ?? 0.5;
  const cropZoom = sticker?.edit.scale ?? 1;
  const squareMeta = sticker ? computeSquareCrop(sticker.width, sticker.height, cropX, cropY, cropZoom) : null;
  // Zoomed out, the square has empty margins: they need a background choice like real alpha does.
  const hasEmptyArea = Boolean(sticker) && (sticker!.has_alpha || cropZoom < 1);
  const stageBgStyle =
    sticker && !isTransparentSelected && (activeProfile === "video-mp4" || !hasEmptyArea)
      ? { backgroundImage: "none", backgroundColor: currentMatte }
      : undefined;

  // Mirrors computeSquareCrop exactly, so the preview is what gets exported.
  const previewStyle: React.CSSProperties | undefined =
    sticker && squareMeta
      ? {
          position: "absolute",
          maxWidth: "none",
          objectFit: "fill",
          pointerEvents: "none",
          width: `${(sticker.width / squareMeta.cropSide) * 100}%`,
          height: `${(sticker.height / squareMeta.cropSide) * 100}%`,
          left: `${(-squareMeta.srcX / squareMeta.cropSide) * 100}%`,
          top: `${(-squareMeta.srcY / squareMeta.cropSide) * 100}%`
        }
      : undefined;

  const applyCrop = (nx: number, ny: number, zoom: number) => {
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    setReadyArtifact(null);
    setProject((prev) =>
      controller.updateStickerEdit(prev, {
        crop_x: Number(clamp01(nx).toFixed(3)),
        crop_y: Number(clamp01(ny).toFixed(3)),
        scale: Number(clampCropZoom(zoom).toFixed(3))
      })
    );
  };

  // Framing gestures: one pointer (finger or mouse) pans, two fingers pinch-zoom, the wheel zooms.
  // The gesture re-bases whenever a finger is added or lifted, so the crop never jumps.
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    start: null as null | { cropX: number; cropY: number; zoom: number; mid: { x: number; y: number }; dist: number },
    moved: false
  });
  const rebaseGesture = () => {
    const pts = [...gesture.current.pointers.values()];
    if (pts.length === 0) {
      gesture.current.start = null;
      return;
    }
    const mid = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    const dist = pts.length >= 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0;
    gesture.current.start = { cropX, cropY, zoom: cropZoom, mid, dist };
  };
  const handleStagePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!sticker) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (gesture.current.pointers.size === 0) gesture.current.moved = false;
    gesture.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rebaseGesture();
  };
  const handleStagePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!sticker || !g.start || !g.pointers.has(e.pointerId)) return; // plain hover does nothing
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const boxPx = previewBoxRef.current?.getBoundingClientRect().width ?? 0;
    if (boxPx <= 0) return;
    const pts = [...g.pointers.values()];
    const mid = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    const dx = mid.x - g.start.mid.x;
    const dy = mid.y - g.start.mid.y;
    if (Math.hypot(dx, dy) > 4) g.moved = true;
    let zoom = g.start.zoom;
    if (pts.length >= 2 && g.start.dist > 0) {
      zoom = clampCropZoom(g.start.zoom * (Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) / g.start.dist));
      g.moved = true;
    }
    // Screen px -> source px, then -> change of the normalized anchor (room = how far the square can travel).
    const { cropSide } = computeSquareCrop(sticker.width, sticker.height, 0.5, 0.5, zoom);
    const srcPerScreen = cropSide / boxPx;
    const roomX = sticker.width - cropSide;
    const roomY = sticker.height - cropSide;
    const nx = Math.abs(roomX) < 1 ? 0.5 : g.start.cropX - (dx * srcPerScreen) / roomX;
    const ny = Math.abs(roomY) < 1 ? 0.5 : g.start.cropY - (dy * srcPerScreen) / roomY;
    applyCrop(nx, ny, zoom);
  };
  const handleStagePointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    gesture.current.pointers.delete(e.pointerId);
    rebaseGesture();
  };
  const handleStageWheel = (e: React.WheelEvent<HTMLElement>) => {
    if (!sticker) return;
    applyCrop(cropX, cropY, cropZoom * Math.exp(-e.deltaY * 0.0015));
  };

  return (
    <div
      className="stik-shell"
      data-testid="stiksound-minimal-app"
      dir={locale === "ar" ? "rtl" : "ltr"}
    >
      <header className="stik-top-corners">
        <button
          type="button"
          data-testid="reset-all-btn"
          className="stik-corner-btn stik-reset-btn"
          title={copy.resetTooltip}
          aria-label={copy.resetTooltip}
          onClick={handleResetAll}
        >
          <IconClose />
        </button>

        <div className="stik-right-actions">
          <button
            type="button"
            data-testid="overflow-menu-btn"
            className="stik-corner-btn stik-menu-btn"
            aria-label="Menu"
            onClick={() => {
              setDownloadMenuOpen(false);
              setMenuOpen((o) => !o);
            }}
          >
            <IconMore />
          </button>

          <button
            type="button"
            data-testid="export-ok-btn"
            className={`stik-corner-btn stik-ok-btn ${canExport ? "ready" : "disabled"}`}
            disabled={!canExport}
            title={exportDisabledReason}
            aria-label={exportDisabledReason}
            onClick={handlePreviewAndCopyArrow}
          >
            {isBusy ? <IconSpinner /> : <IconArrow />}
          </button>
        </div>
      </header>

      {downloadMenuOpen && sticker && (
        <div className="stik-popover" data-testid="download-format-picker">
          <div className="stik-popover-label">{copy.downloadChooseFormat}</div>
          <div className="stik-popover-actions">
            <button
              type="button"
              data-testid="download-fmt-video-mp4"
              disabled={!audio || !trimValid}
              onClick={() => handleDownloadWithFormat("video-mp4")}
            >
              {copy.downloadFmtMp4}
            </button>
            {allowTransparent && (
              <button
                type="button"
                data-testid="download-fmt-video-webm-alpha"
                disabled={!audio || !trimValid}
                onClick={() => handleDownloadWithFormat("video-webm-alpha")}
              >
                {copy.downloadFmtWebm}
              </button>
            )}
            <button
              type="button"
              data-testid="download-fmt-sound-bundle"
              disabled={!audio || !trimValid}
              onClick={() => handleDownloadWithFormat("sound-bundle")}
            >
              {copy.downloadFmtBundle}
            </button>
            <button
              type="button"
              data-testid="download-fmt-standard-webp"
              onClick={() => handleDownloadWithFormat("standard-webp")}
            >
              {copy.downloadFmtWebp}
            </button>
          </div>
        </div>
      )}

      {menuOpen && (
        <div className="stik-popover" data-testid="overflow-menu">
          <div className="stik-popover-actions">
            <label className="stik-popover-row">
              <span>{copy.menuLanguage}</span>
              <select
                data-testid="language-select"
                aria-label={copy.menuLanguage}
                value={locale}
                onChange={(e) => setLocale(e.target.value as LocaleCode)}
              >
                {SUPPORTED_LOCALES.map((code) => (
                  <option key={code} value={code}>
                    {LOCALE_NATIVE_NAMES[code]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="menu-tour-btn"
              onClick={() => {
                setMenuOpen(false);
                setTourOpen(true);
              }}
            >
              {copy.menuTour}
            </button>
            <button
              type="button"
              data-testid="menu-whatsapp-btn"
              onClick={() => {
                setMenuOpen(false);
                setWaGuideOpen(true);
              }}
            >
              {copy.menuWhatsapp}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setAboutOpen(true);
              }}
            >
              {copy.menuAbout}
            </button>
          </div>
        </div>
      )}

      <input
        ref={stickerFileInputRef}
        type="file"
        accept={allowVideoStickers ? `${IMAGE_ACCEPT},${VIDEO_ACCEPT}` : IMAGE_ACCEPT}
        style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) await importStickerBytes(new Uint8Array(await f.arrayBuffer()), f.name);
          e.target.value = "";
        }}
      />

      {readyArtifact ? (
        <main className="stik-preview-ready-card" data-testid="video-preview-ready">
          {readyVideoUrl ? (
            <video
              src={readyVideoUrl}
              controls
              autoPlay
              loop
              playsInline
              className="stik-ready-video"
            />
          ) : (
            <div className="stik-sticker-fallback">{readyArtifact.fileName}</div>
          )}
          <div className="stik-ready-actions">
            <button
              type="button"
              data-testid="copy-again-btn"
              className="stik-pill-btn stik-pill-accent"
              onClick={() => copyArtifactNow(readyArtifact)}
            >
              {copy.copyAgainBtn}
            </button>
            <button
              type="button"
              data-testid="preview-download-btn"
              className="stik-pill-btn"
              onClick={() => setDownloadMenuOpen((o) => !o)}
            >
              <IconDownload size={15} /> {copy.downloadBtnLabel}
            </button>
            <button
              type="button"
              data-testid="back-to-edit-btn"
              className="stik-pill-btn"
              onClick={() => setReadyArtifact(null)}
            >
              {copy.backToEditBtn}
            </button>
          </div>
          <button
            type="button"
            data-testid="ready-whatsapp-help"
            className="stik-link-btn"
            onClick={() => setWaGuideOpen(true)}
          >
            {copy.readyWhatsappHelp}
          </button>
        </main>
      ) : (
        <main
          data-testid="sticker-zone"
          className={`stik-sticker-stage ${sticker ? "has-sticker crop-enabled" : "empty"}`}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerEnd}
          onPointerCancel={handleStagePointerEnd}
          onWheel={handleStageWheel}
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (!f) return;
            if (f.type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac)$/i.test(f.name)) {
              await importAudioBytes(new Uint8Array(await f.arrayBuffer()), f.name);
            } else {
              await importStickerBytes(new Uint8Array(await f.arrayBuffer()), f.name);
            }
          }}
          onClick={() => {
            if (gesture.current.moved) {
              gesture.current.moved = false; // the tap ended a drag/pinch, not a play toggle
              return;
            }
            if (!sticker) stickerFileInputRef.current?.click();
            else if (audio) togglePlay();
          }}
        >
          {!sticker && gifSource ? (
            // GIF search is the main path; uploading (or drag/paste onto the stage) is secondary.
            <div className="stik-empty-sticker stik-empty-choice">
              <button
                type="button"
                data-testid="browse-gifs-btn"
                className="stik-pill-btn stik-pill-accent stik-primary-cta"
                disabled={isBusy}
                onClick={(e) => {
                  e.stopPropagation(); // the stage itself opens the file picker
                  setGifBrowserOpen(true);
                }}
              >
                {copy.browseGifsBtn}
              </button>
              <button
                type="button"
                data-testid="upload-sticker-btn"
                className="stik-pill-btn stik-secondary-btn"
                disabled={isBusy}
                onClick={(e) => {
                  e.stopPropagation();
                  stickerFileInputRef.current?.click();
                }}
              >
                {copy.uploadStickerBtn}
              </button>
              <p className="stik-empty-hint">{copy.stickerDropHint}</p>
            </div>
          ) : !sticker ? (
            <div className="stik-empty-sticker">
              <div className="stik-plus-icon">+</div>
              <p className="stik-empty-title">{copy.stickerDropTitle}</p>
              <p className="stik-empty-hint">{copy.stickerDropHint}</p>
            </div>
          ) : (
            <div className="stik-preview-box" ref={previewBoxRef} style={stageBgStyle}>
              {stickerPreviewUrl && stickerIsVideo ? (
                <video
                  ref={(el) => {
                    previewVideoRef.current = el;
                    // React does not write the muted attribute; iOS needs it to autoplay inline.
                    if (el) {
                      el.muted = true;
                      el.defaultMuted = true;
                      el.setAttribute("muted", "");
                    }
                  }}
                  data-testid="sticker-preview-video"
                  src={stickerPreviewUrl}
                  className="stik-sticker-img"
                  muted
                  autoPlay
                  loop
                  playsInline
                  aria-label={sticker.source_name}
                  style={previewStyle}
                />
              ) : stickerPreviewUrl ? (
                <img
                  src={stickerPreviewUrl}
                  alt={sticker.source_name}
                  className="stik-sticker-img"
                  draggable={false}
                  style={previewStyle}
                />
              ) : (
                <div data-testid="sticker-loaded-badge" className="stik-sticker-fallback">
                  {sticker.source_name}
                </div>
              )}
              {squareMeta && (
                <span data-testid="resolution-pill" className="stik-res-badge">
                  1:1 · {squareMeta.outputSize}×{squareMeta.outputSize} · {copy.hoverCropHint}
                </span>
              )}
              {audio && (
                <span className="stik-speaker-badge" aria-label="Audio attached">
                  🔊
                </span>
              )}
            </div>
          )}
        </main>
      )}

      {!readyArtifact && sticker && (
        <div className="stik-zoom-bar">
          <span aria-hidden="true">🔍</span>
          <input
            type="range"
            data-testid="zoom-slider"
            className="stik-trim-slider stik-zoom-slider"
            aria-label={copy.zoomLabel}
            // log2 scale: 1x sits in the middle, zooming in and out feel symmetric
            min={Math.log2(CROP_ZOOM_MIN)}
            max={Math.log2(CROP_ZOOM_MAX)}
            step={0.01}
            value={Math.log2(cropZoom)}
            onChange={(e) => applyCrop(cropX, cropY, 2 ** Number(e.target.value))}
          />
          <button
            type="button"
            data-testid="crop-reset-btn"
            className="stik-trans-chip"
            onClick={() => applyCrop(0.5, 0.5, 1)}
          >
            {copy.cropReset}
          </button>
        </div>
      )}

      {!readyArtifact && sticker && hasEmptyArea && (
        <div className="stik-transparency-bar" data-testid="transparency-picker">
          <span className="stik-trans-label">{copy.transparencyLabel}</span>
          {allowTransparent && (
            <button
              type="button"
              data-testid="matte-transparent-btn"
              className={`stik-trans-chip ${isTransparentSelected ? "active" : ""}`}
              onClick={selectTransparentMode}
            >
              {copy.modeTransparent}
            </button>
          )}
          <button
            type="button"
            data-testid="matte-white-btn"
            className={`stik-trans-chip ${!isTransparentSelected && currentMatte === "#FFFFFF" ? "active" : ""}`}
            onClick={() => selectSolidMatte("#FFFFFF")}
          >
            {copy.modeWhite}
          </button>
          <button
            type="button"
            data-testid="matte-black-btn"
            className={`stik-trans-chip ${!isTransparentSelected && currentMatte === "#000000" ? "active" : ""}`}
            onClick={() => selectSolidMatte("#000000")}
          >
            {copy.modeBlack}
          </button>
          <label className="stik-color-chip" title={copy.modeCustom}>
            <input
              type="color"
              data-testid="matte-custom-input"
              value={currentMatte}
              onChange={(e) => selectSolidMatte(e.target.value.toUpperCase())}
            />
          </label>
        </div>
      )}

      {(errorMessage || statusMessage) && (
        <div
          data-testid={errorMessage ? "error-banner" : "status-banner"}
          className={`stik-toast ${errorMessage ? "error" : "success"}`}
        >
          {errorMessage ?? statusMessage}
        </div>
      )}

      <TimelineTrimBar
        hasAudio={Boolean(audio) && !changingAudio}
        onChangeAudio={() => {
          stopPlayback();
          setChangingAudio(true);
        }}
        onCancelChange={changingAudio ? () => setChangingAudio(false) : undefined}
        durationMs={audio?.duration_ms ?? 0}
        startMs={assoc?.start_ms ?? 0}
        endMs={assoc?.end_ms ?? 0}
        maxWindowMs={effectiveMaxAudioMs}
        peaks={project.waveformPeaks}
        isPlaying={isPlaying}
        isBusy={isBusy}
        showUrlInput={allowMyInstantsUrl}
        urlInput={urlInput}
        onUrlInputChange={setUrlInput}
        onSubmitUrl={importMyInstantsUrl}
        onBrowseSounds={soundSearch ? () => setBrowserOpen(true) : undefined}
        recording={
          recordAvailable
            ? {
                active: recordingSince !== null,
                elapsedMs: recordingSince !== null ? recordingNow - recordingSince : 0,
                onToggle: () => void toggleRecording()
              }
            : undefined
        }
        onSelectAudioFile={async (f) => importAudioBytes(new Uint8Array(await f.arrayBuffer()), f.name)}
        onChangeRange={handleRangeChange}
        onChangeMaxWindowMs={handleMaxDurationChange}
        onTogglePlay={togglePlay}
        labels={{
          placeholder: copy.audioInputPlaceholder,
          pickBtn: copy.audioPickBtn,
          play: copy.playPreview,
          stop: copy.stopPreview,
          maxDurationAria: copy.maxDurationAria,
          browseBtn: copy.browseSoundsBtn,
          recordBtn: copy.recordBtn,
          recordStop: copy.recordStop,
          changeAudioBtn: copy.changeAudioBtn,
          cancelBtn: copy.cancelBtn
        }}
      />

      {gifBrowserOpen && gifSource && (
        <GifBrowser
          search={(q) => gifSource.search(q)}
          onClose={() => setGifBrowserOpen(false)}
          onPick={(gif) => void importGif(gif)}
          labels={{
            title: copy.gifBrowserTitle,
            placeholder: copy.gifSearchPlaceholder,
            empty: copy.gifEmpty,
            error: copy.gifError,
            close: copy.close
          }}
        />
      )}

      {browserOpen && soundSearch && (
        <SoundBrowser
          search={soundSearch}
          onClose={() => setBrowserOpen(false)}
          onPick={(mediaUrl) => {
            setBrowserOpen(false);
            void importMyInstantsUrl(mediaUrl);
          }}
          labels={{
            title: copy.browseTitle,
            placeholder: copy.browseSearchPlaceholder,
            use: copy.browseUse,
            empty: copy.browseEmpty,
            more: copy.browseMore,
            error: copy.browseError,
            play: copy.playPreview,
            stop: copy.stopPreview,
            close: copy.close
          }}
        />
      )}

      {tourOpen && (
        <Tour
          onClose={closeTour}
          steps={[
            { icon: "🔎", title: copy.tourStep1Title, text: copy.tourStep1Text },
            { icon: "✋", title: copy.tourStep2Title, text: copy.tourStep2Text },
            { icon: "🔊", title: copy.tourStep3Title, text: copy.tourStep3Text },
            { icon: "➜", title: copy.tourStep4Title, text: copy.tourStep4Text }
          ]}
          labels={{
            title: copy.tourTitle,
            next: copy.tourNext,
            back: copy.tourBack,
            skip: copy.tourSkip,
            done: copy.tourDone
          }}
        />
      )}

      {waGuideOpen && (
        <Tour
          onClose={closeWaGuide}
          steps={[
            {
              icon: "📱",
              title: copy.waStep1Title,
              text: copy.waStep1Text,
              image: { src: waSoundButtonImg, alt: copy.waImgSoundAlt }
            },
            {
              icon: "🧪",
              title: copy.waStep2Title,
              text: copy.waStep2Text,
              image: { src: waBecomeTesterImg, alt: copy.waImgTesterAlt },
              // Google Play's standard opt-in page for an app's beta program.
              link: { href: "https://play.google.com/apps/testing/com.whatsapp", label: copy.waBetaLink }
            },
            { icon: "⬆️", title: copy.waStep3Title, text: copy.waStep3Text },
            { icon: "🍎", title: copy.waStep4Title, text: copy.waStep4Text },
            { icon: "🎬", title: copy.waStep5Title, text: copy.waStep5Text },
            {
              icon: "✨",
              title: copy.waStep6Title,
              text: copy.waStep6Text,
              image: { src: waSoundButtonImg, alt: copy.waImgSoundAlt }
            }
          ]}
          labels={{
            title: copy.waGuideTitle,
            next: copy.tourNext,
            back: copy.tourBack,
            skip: copy.close,
            done: copy.tourDone
          }}
        />
      )}

      {aboutOpen && (
        <div className="stik-modal-backdrop" onClick={() => setAboutOpen(false)}>
          <div
            className="stik-modal stik-about-modal"
            data-testid="about-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <svg
              className="stik-about-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 256 256"
              width="64"
              height="64"
              aria-hidden="true"
            >
              <rect x="12" y="12" width="232" height="232" rx="54" fill="#1d1a27" stroke="#A78BFA" strokeWidth="6" />
              <rect x="50" y="54" width="128" height="128" rx="30" fill="#1F2633" stroke="#344054" strokeWidth="4" />
              <path d="M178 148 L144 182 L144 148 Z" fill="#A78BFA" opacity="0.9" />
              <circle cx="96" cy="108" r="10" fill="#F8FAFC" />
              <circle cx="132" cy="108" r="10" fill="#F8FAFC" />
              <path d="M92 136 Q114 156 136 136" fill="none" stroke="#F8FAFC" strokeWidth="8" strokeLinecap="round" />
              <circle cx="184" cy="176" r="44" fill="#A78BFA" />
              <path
                d="M168 178 L168 156 L198 148 L198 172"
                fill="none"
                stroke="#1A1033"
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="163" cy="182" r="8" fill="#1A1033" />
              <circle cx="193" cy="174" r="8" fill="#1A1033" />
            </svg>

            <h3 className="stik-about-title">{copy.appTitle}</h3>
            <p className="stik-about-version">Version {appVersion}</p>
            <p className="stik-about-credits" data-testid="about-credits">
              {copy.aboutMadeBy}{" "}
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                hweg000
              </a>
              <br />
              {copy.aboutBasedOn}{" "}
              <a href={ORIGINAL_REPO_URL} target="_blank" rel="noopener noreferrer">
                StikSound
              </a>{" "}
              © 2026 SilverFeit
            </p>
            <p className="stik-about-subtitle">{copy.aboutSubtitle}</p>
            <p className="stik-about-rights">{copy.aboutRights}</p>

            <div className="stik-about-meta">
              <p>
                {copy.aboutLicenseLine}{" "}
                <a href={`${REPO_URL}/blob/main/LICENSE-MIT`} target="_blank" rel="noopener noreferrer">
                  MIT
                </a>
                {" · "}
                <a href={`${REPO_URL}/blob/main/LICENSE-APACHE`} target="_blank" rel="noopener noreferrer">
                  Apache-2.0
                </a>
              </p>
              <p className="stik-about-github">
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  GitHub ↗
                </a>
              </p>
            </div>

            <details className="stik-about-licenses">
              <summary>{copy.aboutThirdPartyTitle}</summary>
              <p>{copy.aboutThirdPartySummary}</p>
            </details>

            <button type="button" className="stik-pill-btn stik-about-close" onClick={() => setAboutOpen(false)}>
              {copy.close}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
