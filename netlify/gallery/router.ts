/**
 * Community gallery API (runs as a Netlify Function, see netlify/functions/gallery.mts).
 *
 *   GET  /api/gallery                      approved items (public)
 *   POST /api/gallery                      submit (multipart: video, thumb, author?, title?, consent=yes) -> pending
 *   GET  /api/gallery/media/:id/:kind      video | thumb (approved, or any status with admin auth)
 *   POST /api/gallery/report/:id           hide an approved item until the admin reviews it again
 *   GET  /api/gallery/admin                pending / reported / approved (admin)
 *   POST /api/gallery/admin/:id/:action    approve | hide | delete (admin)
 *
 * Nothing is public until the admin approves it. Storage goes through the small KV interface
 * so tests run against an in-memory map instead of Netlify Blobs.
 */

export interface KV {
  getJSON<T>(key: string): Promise<T | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  setBytes(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface Deps {
  kv: KV;
  /** Client IP; only its salted hash is stored (rate limits). */
  ip: string;
  /** ADMIN_PASSWORD env var; admin routes are disabled without it. */
  adminPassword: string | undefined;
  now?: () => Date;
}

export type Status = "pending" | "approved" | "reported";
type VideoType = "video/mp4" | "video/webm";
type ImageType = "image/jpeg" | "image/png" | "image/webp";

export interface GalleryMeta {
  id: string;
  status: Status;
  author: string | null;
  title: string | null;
  createdAt: string;
  videoType: VideoType;
  thumbType: ImageType;
}

/** What the public list exposes. */
export type PublicItem = Pick<GalleryMeta, "id" | "author" | "title" | "createdAt">;

export const LIMITS = {
  // 5-10 s at ~1.2 Mbps is ~1-2 MB, but transparent WebM (MediaRecorder) runs higher.
  // Netlify caps a function request at 6 MB, so 5 MB leaves room for the thumbnail.
  videoMaxBytes: 5 * 1024 * 1024,
  thumbMaxBytes: 200 * 1024,
  authorMaxChars: 30,
  titleMaxChars: 60,
  submitsPerDay: 5,
  reportsPerDay: 10,
  adminFailuresPerHour: 10
} as const;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INDEX_KEY = "index/approved";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

// --- validation (the request body is untrusted) ---------------------------------------

function sniffVideo(b: Uint8Array): VideoType | null {
  if (b.length >= 12 && String.fromCharCode(b[4]!, b[5]!, b[6]!, b[7]!) === "ftyp") return "video/mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP")
    return "image/webp";
  return null;
}

/** Trims, drops control characters, collapses spaces, caps length; empty -> null. */
export function cleanText(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, " ").replace(/\s+/g, " ").trim();
  return s ? [...s].slice(0, maxChars).join("") : null;
}

async function fileBytes(form: FormData, field: string, maxBytes: number): Promise<Uint8Array> {
  const f = form.get(field);
  if (!f || typeof f === "string") throw new HttpError(400, `missing-${field}`);
  if (f.size > maxBytes) throw new HttpError(413, `${field}-too-large`);
  return new Uint8Array(await f.arrayBuffer());
}

// --- helpers ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings via their hashes (no early exit on mismatch). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/** Counts hits per (action, IP, time bucket); throws 429 past the limit. */
async function rateLimit(deps: Deps, action: string, limit: number, bucket: string): Promise<void> {
  const key = `rl/${action}/${bucket}/${await sha256Hex(`stickersound:${deps.ip}`)}`;
  const count = (await deps.kv.getJSON<number>(key)) ?? 0;
  if (count >= limit) throw new HttpError(429, "rate-limited");
  await deps.kv.setJSON(key, count + 1);
}

const dayBucket = (d: Date) => d.toISOString().slice(0, 10);
const hourBucket = (d: Date) => d.toISOString().slice(0, 13);

async function requireAdmin(req: Request, deps: Deps, now: Date): Promise<void> {
  if (!deps.adminPassword) throw new HttpError(503, "admin-disabled");
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (given && (await safeEqual(given, deps.adminPassword))) return;
  await rateLimit(deps, "admin-fail", LIMITS.adminFailuresPerHour, hourBucket(now)); // slows down guessing
  throw new HttpError(401, "unauthorized");
}

async function isAdmin(req: Request, deps: Deps): Promise<boolean> {
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(deps.adminPassword && given && (await safeEqual(given, deps.adminPassword)));
}

const toPublic = (m: GalleryMeta): PublicItem => ({ id: m.id, author: m.author, title: m.title, createdAt: m.createdAt });

async function rebuildIndex(kv: KV): Promise<void> {
  const metas = await allMetas(kv);
  const approved = metas
    .filter((m) => m.status === "approved")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic);
  await kv.setJSON(INDEX_KEY, approved);
}

async function allMetas(kv: KV): Promise<GalleryMeta[]> {
  const keys = await kv.list("meta/");
  const metas = await Promise.all(keys.map((k) => kv.getJSON<GalleryMeta>(k)));
  return metas.filter((m): m is GalleryMeta => m !== null);
}

// --- routes ----------------------------------------------------------------------------

async function submit(req: Request, deps: Deps, now: Date): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "bad-form");
  }
  if (form.get("consent") !== "yes") throw new HttpError(400, "consent-required");
  const video = await fileBytes(form, "video", LIMITS.videoMaxBytes);
  const thumb = await fileBytes(form, "thumb", LIMITS.thumbMaxBytes);
  const videoType = sniffVideo(video);
  const thumbType = sniffImage(thumb);
  if (!videoType) throw new HttpError(415, "video-type");
  if (!thumbType) throw new HttpError(415, "thumb-type");

  await rateLimit(deps, "submit", LIMITS.submitsPerDay, dayBucket(now));

  const meta: GalleryMeta = {
    id: crypto.randomUUID(),
    status: "pending",
    author: cleanText(form.get("author"), LIMITS.authorMaxChars),
    title: cleanText(form.get("title"), LIMITS.titleMaxChars),
    createdAt: now.toISOString(),
    videoType,
    thumbType
  };
  await deps.kv.setBytes(`video/${meta.id}`, video);
  await deps.kv.setBytes(`thumb/${meta.id}`, thumb);
  await deps.kv.setJSON(`meta/${meta.id}`, meta);
  return json(201, { id: meta.id, status: meta.status });
}

async function media(req: Request, deps: Deps, id: string, kind: string): Promise<Response> {
  if (!ID.test(id) || (kind !== "video" && kind !== "thumb")) throw new HttpError(404, "not-found");
  const meta = await deps.kv.getJSON<GalleryMeta>(`meta/${id}`);
  const admin = await isAdmin(req, deps);
  if (!meta || (meta.status !== "approved" && !admin)) throw new HttpError(404, "not-found");
  const bytes = await deps.kv.getBytes(`${kind}/${id}`);
  if (!bytes) throw new HttpError(404, "not-found");
  return new Response(bytes.slice().buffer, {
    status: 200,
    headers: {
      "content-type": kind === "video" ? meta.videoType : meta.thumbType,
      "x-content-type-options": "nosniff",
      // Approved media rarely changes; 1 h keeps a takedown effective soon while sparing credits.
      "cache-control": admin ? "private, no-store" : "public, max-age=3600",
      ...(admin ? {} : { "netlify-cdn-cache-control": "public, max-age=3600" })
    }
  });
}

async function report(deps: Deps, id: string, now: Date): Promise<Response> {
  if (!ID.test(id)) throw new HttpError(404, "not-found");
  await rateLimit(deps, "report", LIMITS.reportsPerDay, dayBucket(now));
  const meta = await deps.kv.getJSON<GalleryMeta>(`meta/${id}`);
  if (!meta || meta.status !== "approved") throw new HttpError(404, "not-found");
  await deps.kv.setJSON(`meta/${id}`, { ...meta, status: "reported" });
  await rebuildIndex(deps.kv);
  return json(200, { ok: true });
}

async function adminList(deps: Deps): Promise<Response> {
  const metas = (await allMetas(deps.kv)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const by = (s: Status) => metas.filter((m) => m.status === s);
  return json(200, { pending: by("pending"), reported: by("reported"), approved: by("approved") }, { "cache-control": "no-store" });
}

async function adminAction(deps: Deps, id: string, action: string): Promise<Response> {
  if (!ID.test(id)) throw new HttpError(404, "not-found");
  const meta = await deps.kv.getJSON<GalleryMeta>(`meta/${id}`);
  if (!meta) throw new HttpError(404, "not-found");
  if (action === "approve" || action === "hide") {
    await deps.kv.setJSON(`meta/${id}`, { ...meta, status: action === "approve" ? "approved" : "pending" });
  } else if (action === "delete") {
    await Promise.all([deps.kv.delete(`meta/${id}`), deps.kv.delete(`video/${id}`), deps.kv.delete(`thumb/${id}`)]);
  } else {
    throw new HttpError(400, "bad-action");
  }
  await rebuildIndex(deps.kv);
  return json(200, { ok: true });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const parts = new URL(req.url).pathname.replace(/^\/api\/gallery\/?/, "").split("/").filter(Boolean);
  try {
    if (parts.length === 0 && req.method === "GET") {
      const items = (await deps.kv.getJSON<PublicItem[]>(INDEX_KEY)) ?? [];
      return json(200, items, { "cache-control": "public, max-age=60", "netlify-cdn-cache-control": "public, max-age=60" });
    }
    if (parts.length === 0 && req.method === "POST") return await submit(req, deps, now);
    if (parts[0] === "media" && parts.length === 3 && req.method === "GET") return await media(req, deps, parts[1]!, parts[2]!);
    if (parts[0] === "report" && parts.length === 2 && req.method === "POST") return await report(deps, parts[1]!, now);
    if (parts[0] === "admin") {
      await requireAdmin(req, deps, now);
      if (parts.length === 1 && req.method === "GET") return await adminList(deps);
      if (parts.length === 3 && req.method === "POST") return await adminAction(deps, parts[1]!, parts[2]!);
    }
    throw new HttpError(404, "not-found");
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.code });
    console.error("gallery error", err);
    return json(500, { error: "server-error" });
  }
}
