import { describe, expect, it } from "vitest";
import { LIMITS, cleanText, handle, type Deps, type KV } from "./router";

function memoryKv(): KV & { keys(): string[] } {
  const m = new Map<string, unknown>();
  return {
    keys: () => [...m.keys()],
    async getJSON<T>(k: string) {
      return (m.has(k) ? structuredClone(m.get(k)) : null) as T | null;
    },
    async getBytes(k) {
      return (m.get(k) as Uint8Array | undefined) ?? null;
    },
    async setJSON(k, v) {
      m.set(k, structuredClone(v));
    },
    async setBytes(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix));
    }
  };
}

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const BASE = "https://sticksound.netlify.app/api/gallery";

function form(fields: Record<string, string | Uint8Array>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === "string" ? v : new Blob([v.slice().buffer]));
  return f;
}

const submit = (deps: Deps, fields: Record<string, string | Uint8Array> = {}) =>
  handle(new Request(BASE, { method: "POST", body: form({ video: MP4, thumb: JPEG, consent: "yes", ...fields }) }), deps);
const get = (deps: Deps, path = "", admin?: string) =>
  handle(new Request(BASE + path, { headers: admin ? { authorization: `Bearer ${admin}` } : {} }), deps);
const post = (deps: Deps, path: string, admin?: string) =>
  handle(new Request(BASE + path, { method: "POST", headers: admin ? { authorization: `Bearer ${admin}` } : {} }), deps);

const makeDeps = (over: Partial<Deps> = {}): Deps & { kv: ReturnType<typeof memoryKv> } => ({
  kv: memoryKv(),
  ip: "203.0.113.7",
  adminPassword: "s3cret",
  now: () => new Date("2026-11-25T12:00:00Z"),
  ...over
}) as Deps & { kv: ReturnType<typeof memoryKv> };

describe("gallery API", () => {
  it("submission stays private until approved; approve, report and delete work end to end", async () => {
    const deps = makeDeps();
    const res = await submit(deps, { author: "  Leo\u0000  el\n crack ", title: "Gato bailando" });
    expect(res.status).toBe(201);
    const { id, status } = await res.json();
    expect(status).toBe("pending");

    // Not public yet: not listed, media hidden (unless admin)
    expect(await (await get(deps)).json()).toEqual([]);
    expect((await get(deps, `/media/${id}/video`)).status).toBe(404);
    expect((await get(deps, `/media/${id}/video`, "s3cret")).status).toBe(200);

    // Admin sees it pending, with the cleaned author
    const queue = await (await get(deps, "/admin", "s3cret")).json();
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].author).toBe("Leo el crack");

    // Approve -> public list + media with the sniffed content type
    expect((await post(deps, `/admin/${id}/approve`, "s3cret")).status).toBe(200);
    const list = await (await get(deps)).json();
    expect(list).toEqual([{ id, author: "Leo el crack", title: "Gato bailando", createdAt: "2026-11-25T12:00:00.000Z" }]);
    const video = await get(deps, `/media/${id}/video`);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(MP4);
    expect((await get(deps, `/media/${id}/thumb`)).headers.get("content-type")).toBe("image/jpeg");

    // Report -> hidden from the public until the admin re-approves
    expect((await post(deps, `/report/${id}`)).status).toBe(200);
    expect(await (await get(deps)).json()).toEqual([]);
    expect((await (await get(deps, "/admin", "s3cret")).json()).reported).toHaveLength(1);

    // Delete -> every key for that item is gone
    expect((await post(deps, `/admin/${id}/delete`, "s3cret")).status).toBe(200);
    expect(deps.kv.keys().filter((k) => k.includes(id))).toEqual([]);
  });

  it("anonymous submissions have no author", async () => {
    const deps = makeDeps();
    const { id } = await (await submit(deps, { author: "   " })).json();
    await post(deps, `/admin/${id}/approve`, "s3cret");
    expect((await (await get(deps)).json())[0].author).toBeNull();
  });

  it("rejects bad uploads: no consent, wrong file types, oversize", async () => {
    const deps = makeDeps();
    expect((await submit(deps, { consent: "no" })).status).toBe(400);
    expect((await submit(deps, { video: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) })).status).toBe(415);
    expect((await submit(deps, { thumb: new Uint8Array([0x3c, 0x73, 0x76, 0x67]) })).status).toBe(415); // "<svg"
    const big = new Uint8Array(LIMITS.videoMaxBytes + 1);
    big.set(MP4);
    expect((await submit(deps, { video: big })).status).toBe(413);
    expect(deps.kv.keys().filter((k) => k.startsWith("meta/"))).toEqual([]);
  });

  it("rate-limits submissions per IP per day", async () => {
    const deps = makeDeps();
    for (let i = 0; i < LIMITS.submitsPerDay; i++) expect((await submit(deps)).status).toBe(201);
    expect((await submit(deps)).status).toBe(429);
    expect((await submit({ ...deps, ip: "198.51.100.1" })).status).toBe(201);
    // the raw IP is never stored
    expect(deps.kv.keys().some((k) => k.includes("203.0.113.7"))).toBe(false);
  });

  it("protects admin routes: wrong password 401 (and rate-limited), no password configured 503", async () => {
    const deps = makeDeps();
    expect((await get(deps, "/admin")).status).toBe(401);
    expect((await get(deps, "/admin", "nope")).status).toBe(401);
    for (let i = 0; i < LIMITS.adminFailuresPerHour; i++) await get(deps, "/admin", "nope");
    expect((await get(deps, "/admin", "nope")).status).toBe(429);
    expect((await get(makeDeps({ adminPassword: undefined }), "/admin", "s3cret")).status).toBe(503);
  });

  it("rejects malformed ids and unknown routes", async () => {
    const deps = makeDeps();
    expect((await get(deps, "/media/../../etc/video")).status).toBe(404);
    expect((await get(deps, "/media/not-an-id/video")).status).toBe(404);
    expect((await post(deps, "/admin/not-an-id/approve", "s3cret")).status).toBe(404);
    expect((await get(deps, "/whatever")).status).toBe(404);
  });

  it("cleanText strips control/invisible chars, collapses spaces and caps length", () => {
    expect(cleanText(" a\u200b\tb\u202e ", 10)).toBe("a b");
    expect(cleanText("x".repeat(50), 30)).toHaveLength(30);
    expect(cleanText(42, 10)).toBeNull();
  });
});
