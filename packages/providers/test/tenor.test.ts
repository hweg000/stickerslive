import { describe, expect, it } from "vitest";
import { TenorGifSource, extractTenorGifs, gifFrameStats, validateTenorMediaUrl, type FetchLike } from "../src/index";

/** Minimal structurally valid GIF: header, no color table, N empty image descriptors, trailer. */
function makeGif(w: number, h: number, frames: number): Uint8Array<ArrayBuffer> {
  const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0];
  const frame = [0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 0x02, 0x00];
  return new Uint8Array([...head, ...Array.from({ length: frames }, () => frame).flat(), 0x3b]);
}

const img = (id: string, slug: string, alt: string) =>
  `<img src="https://media.tenor.com/${id}AAAAM/${slug}.gif" width="180" height="180" alt="${alt}" loading="lazy">`;

const html =
  img("8pg6pKEUmT0", "egg-cat", "a cat &amp; an egg") +
  img("8pg6pKEUmT0", "egg-cat", "duplicate") +
  `<img src="https://media.tenor.com/BCQJFkjyNYwAAAAm/sticker.webp" alt="webp sticker, skipped">` +
  `<img src="https://evil.example/xAAAAM/x.gif" alt="other host, skipped">` +
  img("DcRO1-0Kn9w", "cats-drooling", "drool");

describe("packages/providers Tenor GIF source", () => {
  it("extracts deduped GIF results with full-size URLs from a search page", () => {
    expect(extractTenorGifs(html)).toEqual([
      {
        title: "a cat & an egg",
        preview_url: "https://media.tenor.com/8pg6pKEUmT0AAAAM/egg-cat.gif",
        gif_url: "https://media.tenor.com/8pg6pKEUmT0AAAAd/egg-cat.gif"
      },
      {
        title: "drool",
        preview_url: "https://media.tenor.com/DcRO1-0Kn9wAAAAM/cats-drooling.gif",
        gif_url: "https://media.tenor.com/DcRO1-0Kn9wAAAAd/cats-drooling.gif"
      }
    ]);
  });

  it("builds the search URL from the query and defaults to memes", async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (u) => {
      urls.push(String(u));
      return new Response(html, { status: 200 });
    };
    const source = new TenorGifSource(fetchFn);
    expect(await source.search("  Gato  Bailando ")).toHaveLength(2);
    await source.search("");
    expect(urls).toEqual(["https://tenor.com/search/gato-bailando-gifs", "https://tenor.com/search/memes-gifs"]);
  });

  it("download picks the first size that fits the sticker limits (medium → tiny → nano)", async () => {
    const gif = extractTenorGifs(html)[0]!;
    const tooManyFrames = makeGif(100, 100, 301);
    const ok = makeGif(100, 100, 3);
    expect(gifFrameStats(ok)).toEqual({ width: 100, height: 100, frames: 3 });

    const requested: string[] = [];
    const fetchFn: FetchLike = async (u) => {
      const s = String(u);
      requested.push(s.split("/")[3]!.slice(-5));
      if (s.includes("AAAAd")) return new Response(tooManyFrames);
      return new Response(ok);
    };
    expect(await new TenorGifSource(fetchFn).download(gif)).toEqual(ok);
    expect(requested).toEqual(["AAAAd", "AAAAM"]);

    // Nothing fits -> file-too-large; nothing downloads -> remote-unavailable
    await expect(new TenorGifSource(async () => new Response(tooManyFrames)).download(gif)).rejects.toThrow(
      /exceeds the sticker limits/
    );
    await expect(new TenorGifSource(async () => new Response("", { status: 404 })).download(gif)).rejects.toThrow(
      /Could not download/
    );
  });

  it("only allows https://media.tenor.com media URLs", () => {
    expect(() => validateTenorMediaUrl("https://evil.example/x.gif")).toThrowError(/not allowed/);
    expect(() => validateTenorMediaUrl("http://media.tenor.com/x.gif")).toThrowError(/not allowed/);
  });
});
