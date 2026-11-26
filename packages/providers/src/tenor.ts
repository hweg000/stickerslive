import { LIMITS, StikSoundError } from "@stiksound/core";
import type { FetchLike } from "./myinstants-provider";

export interface GifResult {
  title: string;
  /** Small GIF for the result grid. */
  preview_url: string;
  /** Medium GIF, the preferred size to import as the sticker. */
  gif_url: string;
  /** Preview size from the page, so the grid can reserve the right shape before it loads. */
  width?: number;
  height?: number;
  /** Where the result came from; results of different providers are never mixed in one list. */
  provider?: "klipy" | "tenor";
  /** KLIPY only: small GIF used when the medium one is too heavy. */
  small_url?: string;
}

// Server-rendered results: <img src="https://media.tenor.com/<id>AAAAM/<slug>.gif" ... alt="...">.
// Size suffixes of the same item: AAAAd medium, AAAAM tiny, AAAAS nano. (AAAAC is full size,
// often 20+ MB / 300 frames, which the sticker pipeline rejects, so it is never used.)
const SIZE_FALLBACKS = ["AAAAd", "AAAAM", "AAAAS"] as const;
// Keep well under the decoder's 256 MB cap; a 512 px sticker gains nothing from bigger GIFs.
const MAX_DECODED_BYTES = LIMITS.MAX_GIF_DECODED_BYTES / 2;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** Canvas size and frame count from a GIF's block structure (heuristic only; the engine validates fully). */
export function gifFrameStats(b: Uint8Array): { width: number; height: number; frames: number } | null {
  if (b.length < 13 || String.fromCharCode(b[0]!, b[1]!, b[2]!) !== "GIF") return null;
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  let p = 13;
  if (b[10]! & 0x80) p += 3 * (1 << ((b[10]! & 7) + 1));
  let frames = 0;
  const skipSubBlocks = () => {
    while (p < b.length && b[p]) p += b[p]! + 1;
    p++;
  };
  while (p < b.length) {
    const block = b[p++];
    if (block === 0x21) {
      p++;
      skipSubBlocks();
    } else if (block === 0x2c) {
      frames++;
      const flags = b[p + 8] ?? 0;
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; // LZW minimum code size
      skipSubBlocks();
    } else {
      break; // 0x3b trailer or garbage
    }
  }
  return { width, height, frames };
}

export function fitsStickerLimits(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return false;
  const s = gifFrameStats(bytes);
  if (!s) return false;
  return s.frames <= LIMITS.MAX_GIF_FRAMES && s.width * s.height * 4 * Math.max(1, s.frames) <= MAX_DECODED_BYTES;
}
const TENOR_IMG_REGEX =
  /<img\s+src="(https:\/\/media\.tenor\.com\/[A-Za-z0-9_-]+)AAAAM(\/[A-Za-z0-9._~%-]+\.gif)"[^>]*?alt="([^"]*)"/gi;

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function extractTenorGifs(html: string): GifResult[] {
  const out: GifResult[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(TENOR_IMG_REGEX)) {
    const preview = `${m[1]}AAAAM${m[2]}`;
    if (seen.has(preview)) continue;
    seen.add(preview);
    const width = Number(/\bwidth="([\d.]+)"/.exec(m[0])?.[1]);
    const height = Number(/\bheight="([\d.]+)"/.exec(m[0])?.[1]);
    out.push({
      title: decodeEntities(m[3] ?? "").trim(),
      preview_url: preview,
      gif_url: `${m[1]}AAAAd${m[2]}`,
      ...(width > 0 && height > 0 ? { width, height } : {})
    });
  }
  return out;
}

/** Only https://media.tenor.com GIFs are downloaded (the result HTML is untrusted). */
export function validateTenorMediaUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new StikSoundError("url-rejected", "Malformed GIF URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "media.tenor.com" || url.port || url.username || url.password) {
    throw new StikSoundError("url-rejected", `GIF host not allowed: ${url.host}`);
  }
  return url;
}

export class TenorGifSource {
  constructor(private readonly fetchFn: FetchLike = globalThis.fetch) {}

  /** shortcut: one results page per search (Tenor's "load more" needs an API key); empty query shows memes. */
  public async search(query: string): Promise<GifResult[]> {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const slug = (words.length ? words : ["memes"]).map(encodeURIComponent).join("-");
    const res = await this.fetchFn(`https://tenor.com/search/${slug}-gifs`, { credentials: "omit" });
    if (!res.ok) throw new StikSoundError("remote-unavailable", `HTTP ${res.status} from Tenor.`);
    return extractTenorGifs(await res.text());
  }

  /** Downloads the largest size (medium → tiny → nano) that fits the sticker limits. */
  public async download(gif: GifResult): Promise<Uint8Array> {
    let anyTooBig = false;
    for (const size of SIZE_FALLBACKS) {
      const url = gif.preview_url.replace(/AAAAM(\/[^/]+)$/, `${size}$1`);
      const res = await this.fetchFn(validateTenorMediaUrl(url).toString(), { credentials: "omit" });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (fitsStickerLimits(bytes)) return bytes;
      anyTooBig = true;
    }
    throw anyTooBig
      ? new StikSoundError("file-too-large", "Every Tenor size of this GIF exceeds the sticker limits.")
      : new StikSoundError("remote-unavailable", "Could not download the GIF from Tenor.");
  }
}
