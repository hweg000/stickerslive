/**
 * GIF search through KLIPY (runs as a Netlify Function, see netlify/functions/gifs.mts).
 *
 *   GET /api/gifs?q=cat&page=1   -> { provider: "klipy", items: [...], has_next }
 *   empty q                      -> trending
 *
 * The API key stays on the server. KLIPY's terms forbid caching or storing their content,
 * so responses are no-store and nothing is kept; the browser loads the media straight from
 * KLIPY's CDN (static.klipy.com allows CORS).
 */

export interface KlipyItem {
  slug: string;
  title: string;
  /** Small animated preview for the grid. */
  preview_url: string;
  /** Medium GIF to import as the sticker. */
  gif_url: string;
  /** Small GIF, fallback when the medium one is too heavy for the sticker pipeline. */
  small_url: string | null;
  width?: number;
  height?: number;
}

interface KlipyFile {
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}

// Same cap as fitsStickerLimits (packages/providers/src/tenor.ts). KLIPY's "md" GIFs can be 15 MB;
// picking by the advertised size avoids the browser downloading one only to discard it.
const STICKER_MAX_BYTES = 8 * 1024 * 1024;
const fitsSticker = (f: KlipyFile | undefined) =>
  isKlipyMediaUrl(f?.url) && (typeof f!.size !== "number" || f!.size <= STICKER_MAX_BYTES);
type KlipySize = Partial<Record<"gif" | "webp" | "jpg" | "mp4" | "webm", KlipyFile>>;
interface KlipyRawItem {
  slug?: string;
  title?: string;
  file?: Partial<Record<"hd" | "md" | "sm" | "xs", KlipySize>>;
}

const API = "https://api.klipy.com/api/v1";
const MAX_QUERY = 100;
const MAX_PAGE = 20;

/** Only https media from KLIPY's own hosts reaches the browser. */
export function isKlipyMediaUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.port && !u.username && (u.hostname === "klipy.com" || u.hostname.endsWith(".klipy.com"));
  } catch {
    return false;
  }
}

export function mapKlipyItems(raw: unknown): KlipyItem[] {
  const list = (raw as { data?: { data?: unknown } })?.data?.data;
  if (!Array.isArray(list)) return [];
  const out: KlipyItem[] = [];
  for (const it of list as KlipyRawItem[]) {
    const sm = it.file?.sm;
    const md = it.file?.md;
    const preview = sm?.webp ?? sm?.gif;
    // Largest GIF within the sticker limits, then the next smaller one as fallback.
    const [gif, smaller] = [md?.gif, sm?.gif, it.file?.xs?.gif].filter(fitsSticker);
    if (!isKlipyMediaUrl(preview?.url) || !isKlipyMediaUrl(gif?.url) || typeof it.slug !== "string") continue;
    out.push({
      slug: it.slug,
      title: typeof it.title === "string" ? it.title.slice(0, 120) : "",
      preview_url: preview!.url!,
      gif_url: gif!.url!,
      small_url: smaller?.url ?? null,
      ...(preview!.width && preview!.height ? { width: preview!.width, height: preview!.height } : {})
    });
  }
  return out;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

export async function handleGifs(
  req: Request,
  deps: { apiKey: string | undefined; fetchFn?: typeof fetch }
): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "method" });
  if (!deps.apiKey) return json(503, { error: "klipy-disabled" });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)));
  const params = new URLSearchParams({
    page: String(page),
    per_page: "30",
    locale: "mx",
    content_filter: "medium",
    format_filter: "gif,webp"
  });
  if (q) params.set("q", q);
  const endpoint = `${API}/${encodeURIComponent(deps.apiKey)}/gifs/${q ? "search" : "trending"}?${params}`;

  let res: Response;
  try {
    res = await (deps.fetchFn ?? fetch)(endpoint, { headers: { accept: "application/json" } });
  } catch {
    return json(502, { error: "klipy-unreachable" });
  }
  // Never echo upstream details: the request URL contains the API key.
  if (res.status === 429) return json(429, { error: "klipy-rate-limited" });
  if (!res.ok) return json(502, { error: "klipy-error", status: res.status });
  const body = await res.json().catch(() => null);
  return json(200, {
    provider: "klipy",
    items: mapKlipyItems(body),
    has_next: Boolean((body as { data?: { has_next?: unknown } })?.data?.has_next)
  });
}
