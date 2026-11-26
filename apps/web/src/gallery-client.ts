import type { RgbaFrame512 } from "@stiksound/core";
import type { GalleryClient, GalleryItem } from "@stiksound/ui";

/** Community gallery API (Netlify Function, see netlify/gallery/router.ts). */
const API = "/api/gallery";

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
}

/**
 * Gallery thumbnails are what most visitors download, so keep them tiny:
 * 256 px JPEG (~15 KB) instead of the 512 px sticker. JPEG has no alpha, so
 * transparent pixels get the chosen background.
 */
async function thumbnailJpeg(frame: RgbaFrame512, background: string): Promise<Blob> {
  const src = document.createElement("canvas");
  src.width = frame.width;
  src.height = frame.height;
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  const size = 256;
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(src, 0, 0, size, size);
  return new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("thumbnail failed"))), "image/jpeg", 0.82)
  );
}

export const galleryClient: GalleryClient = {
  async list() {
    const res = await fetch(API);
    if (!res.ok) return fail(res);
    return (await res.json()) as GalleryItem[];
  },
  mediaUrl(id, kind) {
    return `${API}/media/${encodeURIComponent(id)}/${kind}`;
  },
  async submit({ video, thumb, thumbBackground, author, title }) {
    // Same cap as the server (netlify/gallery/router.ts LIMITS.videoMaxBytes): fail before uploading.
    if (video.bytes.byteLength > 5 * 1024 * 1024) {
      throw Object.assign(new Error("video-too-large"), { status: 413 });
    }
    const form = new FormData();
    form.append("video", new Blob([video.bytes.slice().buffer], { type: video.mimeType }), video.fileName);
    form.append("thumb", await thumbnailJpeg(thumb, thumbBackground), "thumb.jpg");
    form.append("author", author);
    form.append("title", title);
    form.append("consent", "yes");
    const res = await fetch(API, { method: "POST", body: form });
    if (!res.ok) return fail(res);
  },
  async report(id) {
    const res = await fetch(`${API}/report/${encodeURIComponent(id)}`, { method: "POST" });
    if (!res.ok) return fail(res);
  }
};
