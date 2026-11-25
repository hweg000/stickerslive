import { StikSoundError, computeSquareCrop, stickerMimeType, type VideoFormat } from "@stiksound/core";

/**
 * Helpers for using a short video clip as a sticker source, built on a hidden <video> element.
 * Seeking a media element works in every browser that can play the clip (including iPhone HEVC
 * clips in Safari), so no demuxer or decoder library is needed.
 */

export interface OpenedVideo {
  el: HTMLVideoElement;
  width: number;
  height: number;
  durationMs: number;
  dispose(): void;
}

function waitForEvent(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new StikSoundError("unsupported-video", `Timed out waiting for ${event}.`));
    }, timeoutMs);
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new StikSoundError("unsupported-video", "The browser could not decode this video."));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
    };
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

/** Load a clip far enough to read its size and draw frames. Rejects with "unsupported-video". */
export async function openVideo(bytes: Uint8Array, format: VideoFormat): Promise<OpenedVideo> {
  if (typeof document === "undefined") {
    throw new StikSoundError("unsupported-video", "Video stickers need a browser document.");
  }
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: stickerMimeType(format) }));
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.setAttribute("playsinline", "");
  el.setAttribute("muted", "");
  el.preload = "auto";
  const dispose = () => {
    el.pause();
    el.removeAttribute("src");
    el.load();
    URL.revokeObjectURL(url);
  };

  try {
    const ready = waitForEvent(el, "loadeddata", 15_000);
    el.src = url;
    el.load();
    // iOS sometimes holds back frame data until playback starts; muted playback is always allowed.
    const nudge = window.setTimeout(() => {
      el.play().then(() => el.pause()).catch(() => undefined);
    }, 1500);
    await ready.finally(() => window.clearTimeout(nudge));

    if (!el.videoWidth || !el.videoHeight || !Number.isFinite(el.duration) || el.duration <= 0) {
      throw new StikSoundError("unsupported-video", "Video has no picture or no duration.");
    }
    return {
      el,
      width: el.videoWidth,
      height: el.videoHeight,
      durationMs: Math.round(el.duration * 1000),
      dispose
    };
  } catch (err) {
    dispose();
    throw err instanceof StikSoundError ? err : new StikSoundError("unsupported-video", String(err));
  }
}

/** Seek to a time (seconds) and resolve once that frame can be drawn. */
export async function seekVideo(el: HTMLVideoElement, timeSec: number): Promise<void> {
  const target = Math.max(0, Math.min(timeSec, el.duration - 0.02));
  if (Math.abs(el.currentTime - target) < 0.001 && el.readyState >= 2) return;
  const done = waitForEvent(el, "seeked", 5000);
  el.currentTime = target;
  await done;
}

/** Draw the 1:1 crop of the current video frame, over a matte colour (null = keep transparent). */
export function drawCroppedFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  video: OpenedVideo,
  cropX: number,
  cropY: number,
  matteColor: string | null,
  zoom = 1
): number {
  const crop = computeSquareCrop(video.width, video.height, cropX, cropY, zoom);
  if (matteColor) {
    ctx.fillStyle = matteColor;
    ctx.fillRect(0, 0, crop.outputSize, crop.outputSize);
  } else {
    ctx.clearRect(0, 0, crop.outputSize, crop.outputSize);
  }
  ctx.drawImage(
    video.el,
    crop.srcX,
    crop.srcY,
    crop.cropSide,
    crop.cropSide,
    0,
    0,
    crop.outputSize,
    crop.outputSize
  );
  return crop.outputSize;
}

/** Map a time inside the rendered segment to a time in the clip, looping short clips. */
export function clipTimeSec(offsetMs: number, segmentMs: number, clipDurationMs: number): number {
  const t = offsetMs + segmentMs;
  return (clipDurationMs > 0 ? t % clipDurationMs : t) / 1000;
}
