import { StikSoundError } from "@stiksound/core";
import type { FetchLike } from "./myinstants-provider";
import { fitsStickerLimits, type GifResult } from "./tenor";

/** Only https media from KLIPY's own hosts is downloaded (mirrors the server-side check). */
export function isKlipyMediaUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.port && !u.username && (u.hostname === "klipy.com" || u.hostname.endsWith(".klipy.com"));
  } catch {
    return false;
  }
}

interface ApiItem {
  title?: unknown;
  preview_url?: unknown;
  gif_url?: unknown;
  small_url?: unknown;
  width?: unknown;
  height?: unknown;
}

/**
 * GIF search through the app's /api/gifs function (it holds the KLIPY key).
 * Media is loaded straight from KLIPY's CDN, never cached or stored by us (KLIPY API terms).
 */
export class KlipyGifSource {
  constructor(
    private readonly fetchFn: FetchLike = (input, init) => globalThis.fetch(input, init),
    private readonly endpoint = "/api/gifs"
  ) {}

  public async search(query: string): Promise<GifResult[]> {
    const res = await this.fetchFn(`${this.endpoint}?q=${encodeURIComponent(query.trim())}`, { credentials: "omit" });
    if (!res.ok) throw new StikSoundError("remote-unavailable", `KLIPY search HTTP ${res.status}.`);
    const body = (await res.json()) as { items?: ApiItem[] };
    const out: GifResult[] = [];
    for (const it of body.items ?? []) {
      if (!isKlipyMediaUrl(it.preview_url) || !isKlipyMediaUrl(it.gif_url)) continue;
      out.push({
        title: typeof it.title === "string" ? it.title : "",
        preview_url: it.preview_url,
        gif_url: it.gif_url,
        provider: "klipy",
        ...(isKlipyMediaUrl(it.small_url) ? { small_url: it.small_url } : {}),
        ...(typeof it.width === "number" && typeof it.height === "number" ? { width: it.width, height: it.height } : {})
      });
    }
    return out;
  }

  /** Medium GIF, or the small one when the medium is over the sticker limits. */
  public async download(gif: GifResult): Promise<Uint8Array> {
    let anyTooBig = false;
    for (const url of [gif.gif_url, gif.small_url]) {
      if (!url) continue;
      if (!isKlipyMediaUrl(url)) throw new StikSoundError("url-rejected", "GIF host not allowed.");
      const res = await this.fetchFn(url, { credentials: "omit" });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (fitsStickerLimits(bytes)) return bytes;
      anyTooBig = true;
    }
    throw anyTooBig
      ? new StikSoundError("file-too-large", "Every KLIPY size of this GIF exceeds the sticker limits.")
      : new StikSoundError("remote-unavailable", "Could not download the GIF from KLIPY.");
  }
}
