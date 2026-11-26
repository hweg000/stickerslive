import { describe, expect, it, vi } from "vitest";
import { handleGifs, isKlipyMediaUrl, mapKlipyItems } from "./klipy";

const item = (slug: string, host = "static.klipy.com") => ({
  id: 1,
  slug,
  title: "Hello",
  file: {
    md: { gif: { url: `https://${host}/md/${slug}.gif`, width: 320, height: 320 } },
    sm: {
      gif: { url: `https://${host}/sm/${slug}.gif`, width: 220, height: 180 },
      webp: { url: `https://${host}/sm/${slug}.webp`, width: 220, height: 180 }
    }
  },
  type: "gif"
});
const klipyBody = (items: unknown[], has_next = true) => ({ result: true, data: { data: items, current_page: 1, per_page: 30, has_next } });

describe("KLIPY GIF search function", () => {
  it("searches with the key on the server and returns only safe, mapped fields (no-store)", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(klipyBody([item("hi-1"), item("evil", "evil.example")]))));
    const res = await handleGifs(new Request("https://s.app/api/gifs?q=%20gato%20&page=2"), { apiKey: "KEY123", fetchFn });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const called = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(called.pathname).toBe("/api/v1/KEY123/gifs/search");
    expect(called.searchParams.get("q")).toBe("gato");
    expect(called.searchParams.get("page")).toBe("2");
    const body = await res.json();
    expect(body).toEqual({
      provider: "klipy",
      has_next: true,
      items: [
        {
          slug: "hi-1",
          title: "Hello",
          preview_url: "https://static.klipy.com/sm/hi-1.webp",
          gif_url: "https://static.klipy.com/md/hi-1.gif",
          small_url: "https://static.klipy.com/sm/hi-1.gif",
          width: 220,
          height: 180
        }
      ]
    });
    // The key never reaches the browser
    expect(JSON.stringify(body)).not.toContain("KEY123");
  });

  it("uses trending for an empty query and clamps page/query", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(klipyBody([]))));
    await handleGifs(new Request(`https://s.app/api/gifs?page=999&q=${"x".repeat(300)}`), { apiKey: "K", fetchFn });
    await handleGifs(new Request("https://s.app/api/gifs"), { apiKey: "K", fetchFn });
    const first = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(first.searchParams.get("page")).toBe("20");
    expect(first.searchParams.get("q")).toHaveLength(100);
    expect(new URL(String(fetchFn.mock.calls[1]![0])).pathname).toBe("/api/v1/K/gifs/trending");
  });

  it("503 without a key, 429 passthrough, 502 on upstream errors without leaking details", async () => {
    expect((await handleGifs(new Request("https://s.app/api/gifs"), { apiKey: undefined })).status).toBe(503);
    const limited = await handleGifs(new Request("https://s.app/api/gifs?q=a"), {
      apiKey: "SECRET",
      fetchFn: async () => new Response("slow down", { status: 429 })
    });
    expect(limited.status).toBe(429);
    const broken = await handleGifs(new Request("https://s.app/api/gifs?q=a"), {
      apiKey: "SECRET",
      fetchFn: async () => {
        throw new Error("https://api.klipy.com/api/v1/SECRET/... failed");
      }
    });
    expect(broken.status).toBe(502);
    expect(await broken.text()).not.toContain("SECRET");
  });

  it("only allows https media on klipy.com hosts", () => {
    expect(isKlipyMediaUrl("https://static.klipy.com/a.gif")).toBe(true);
    expect(isKlipyMediaUrl("http://static.klipy.com/a.gif")).toBe(false);
    expect(isKlipyMediaUrl("https://klipy.com.evil.example/a.gif")).toBe(false);
    expect(mapKlipyItems({ nope: 1 })).toEqual([]);
  });
});
