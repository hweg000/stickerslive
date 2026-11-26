import { describe, expect, it } from "vitest";
import { KlipyGifSource, isKlipyMediaUrl, type FetchLike } from "../src/index";

/** Minimal structurally valid GIF with N empty frames (same helper as tenor.test.ts). */
function makeGif(w: number, h: number, frames: number): Uint8Array<ArrayBuffer> {
  const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0];
  const frame = [0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 0x02, 0x00];
  return new Uint8Array([...head, ...Array.from({ length: frames }, () => frame).flat(), 0x3b]);
}

const apiItems = {
  provider: "klipy",
  items: [
    {
      title: "Hello",
      preview_url: "https://static.klipy.com/sm/a.webp",
      gif_url: "https://static.klipy.com/md/a.gif",
      small_url: "https://static.klipy.com/sm/a.gif",
      width: 220,
      height: 180
    },
    { title: "evil", preview_url: "https://evil.example/a.webp", gif_url: "https://static.klipy.com/md/b.gif" }
  ]
};

describe("KLIPY GIF source (browser side)", () => {
  it("calls the app's /api/gifs, keeps only klipy.com media and tags results as KLIPY", async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (u) => {
      urls.push(String(u));
      return new Response(JSON.stringify(apiItems));
    };
    const results = await new KlipyGifSource(fetchFn).search("  gato bailando ");
    expect(urls).toEqual(["/api/gifs?q=gato%20bailando"]);
    expect(results).toEqual([
      {
        title: "Hello",
        preview_url: "https://static.klipy.com/sm/a.webp",
        gif_url: "https://static.klipy.com/md/a.gif",
        small_url: "https://static.klipy.com/sm/a.gif",
        provider: "klipy",
        width: 220,
        height: 180
      }
    ]);
  });

  it("throws when the function is unavailable (no key / rate limit) so the app can fall back", async () => {
    const src = new KlipyGifSource(async () => new Response("{}", { status: 503 }));
    await expect(src.search("x")).rejects.toThrow(/HTTP 503/);
  });

  it("downloads the medium GIF, falls back to the small one when it is over the limits", async () => {
    const ok = makeGif(100, 100, 3);
    const tooManyFrames = makeGif(100, 100, 301);
    const requested: string[] = [];
    const src = new KlipyGifSource(async (u) => {
      requested.push(String(u));
      return new Response(String(u).includes("/md/") ? tooManyFrames : ok);
    });
    const gif = {
      title: "",
      preview_url: "https://static.klipy.com/sm/a.webp",
      gif_url: "https://static.klipy.com/md/a.gif",
      small_url: "https://static.klipy.com/sm/a.gif",
      provider: "klipy" as const
    };
    expect(await src.download(gif)).toEqual(ok);
    expect(requested).toEqual(["https://static.klipy.com/md/a.gif", "https://static.klipy.com/sm/a.gif"]);

    // An oversized file is skipped from its Content-Length, without reading the body
    let bodyRead = false;
    const lazy = new KlipyGifSource(async (u) => {
      if (String(u).includes("/md/")) {
        const heavy = new Response(null, { headers: { "content-length": String(15 * 1024 * 1024) } });
        heavy.arrayBuffer = async () => {
          bodyRead = true;
          return new ArrayBuffer(0);
        };
        return heavy;
      }
      return new Response(ok);
    });
    expect(await lazy.download(gif)).toEqual(ok);
    expect(bodyRead).toBe(false);

    await expect(src.download({ ...gif, gif_url: "https://evil.example/x.gif" })).rejects.toThrow(/not allowed/);
    expect(isKlipyMediaUrl("https://static.klipy.com.evil.example/x.gif")).toBe(false);
  });
});
