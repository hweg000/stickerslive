import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@stiksound/core";
import {
  MyInstantsProvider,
  extractMyInstantsFromHtml,
  isPrivateOrReservedIp,
  validateMyInstantsUrl,
  type FetchLike
} from "../src/index";

const fixturesDir = path.resolve(__dirname, "../../../fixtures/myinstants");

describe("packages/providers MyInstants & SSRF security", () => {
  it("TC-004: extracts media URL and clean title from HTML fixture", () => {
    const html = fs.readFileSync(path.join(fixturesDir, "instant-page.html"), "utf-8");
    const result = extractMyInstantsFromHtml(html);
    expect(result).toEqual({
      title: "Airhorn Classic",
      media_url: "https://www.myinstants.com/media/sounds/airhorn-fixture.mp3"
    });
  });

  it("TC-005: fails with remote-unavailable when page has no media URL", () => {
    const html = fs.readFileSync(path.join(fixturesDir, "instant-page-missing.html"), "utf-8");
    expect(() => extractMyInstantsFromHtml(html)).toThrowError(/remote-unavailable/);
  });

  it("SEC-001 & SEC-002: rejects http, userinfo, non-443 ports, raw IPs, and non-allowlisted hosts", () => {
    expect(() => validateMyInstantsUrl("http://www.myinstants.com/en/instant/airhorn/")).toThrowError(/url-rejected/);
    expect(() => validateMyInstantsUrl("https://www.myinstants.com@evil.example/a.mp3")).toThrowError(/url-rejected/);
    expect(() => validateMyInstantsUrl("https://www.myinstants.com:8443/en/instant/a/")).toThrowError(/url-rejected/);
    expect(() => validateMyInstantsUrl("https://127.0.0.1/media/sounds/a.mp3")).toThrowError(/url-rejected/);
    expect(() => validateMyInstantsUrl("https://evil.example/media/sounds/a.mp3")).toThrowError(/url-rejected/);

    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.10")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
  });

  it("SEC-003 & SEC-004: rejects redirects to loopback or non-allowlisted hosts", async () => {
    const redirectLoopbackFetch: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
    const provider1 = new MyInstantsProvider(redirectLoopbackFetch);
    await expect(provider1.resolve("https://www.myinstants.com/media/sounds/test.mp3")).rejects.toMatchObject({
      code: "url-rejected"
    });

    const redirectEvilFetch: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/audio.mp3" } });
    const provider2 = new MyInstantsProvider(redirectEvilFetch);
    await expect(provider2.resolve("https://www.myinstants.com/media/sounds/test.mp3")).rejects.toMatchObject({
      code: "url-rejected"
    });
  });

  it("SEC-005: aborts bodies exceeding 25 MB limit with file-too-large", async () => {
    const oversizeFetch: FetchLike = async () =>
      new Response(null, {
        status: 200,
        headers: { "content-length": String(LIMITS.MAX_AUDIO_BYTES + 1) }
      });
    const provider = new MyInstantsProvider(oversizeFetch);
    await expect(provider.resolve("https://www.myinstants.com/media/sounds/big.mp3")).rejects.toMatchObject({
      code: "file-too-large"
    });
  });

  it("resolves an instant page URL offline via mocked fetch", async () => {
    const html = fs.readFileSync(path.join(fixturesDir, "instant-page.html"), "utf-8");
    const mp3Stub = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]);
    const mockFetch: FetchLike = async (url) => {
      if (String(url).endsWith(".mp3")) {
        return new Response(mp3Stub, { status: 200 });
      }
      return new Response(html, { status: 200 });
    };
    const provider = new MyInstantsProvider(mockFetch);
    const resolved = await provider.resolve("https://www.myinstants.com/en/instant/airhorn-classic/?utm=share");
    expect(resolved.page_url).toBe("https://www.myinstants.com/en/instant/airhorn-classic/");
    expect(resolved.media_url).toBe("https://www.myinstants.com/media/sounds/airhorn-fixture.mp3");
    expect(resolved.title).toBe("Airhorn Classic");
    expect(resolved.bytes).toEqual(mp3Stub);
  });

  it("handles Spanish share URLs (?utm_source=copy&utm_medium=share), missing trailing slash, and Spanish og:title", async () => {
    const spanishHtml = `<!doctype html><html><head><meta property="og:title" content="gi steel pipe - Botón de sonido"/></head><body><a href="/media/sounds/gi-steel-pipe.mp3" download>Download</a></body></html>`;
    const mp3Stub = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]);
    const requestedUrls: string[] = [];
    const mockFetch: FetchLike = async (url) => {
      const s = String(url);
      requestedUrls.push(s);
      if (s.endsWith(".mp3")) return new Response(mp3Stub, { status: 200 });
      return new Response(spanishHtml, { status: 200 });
    };
    const provider = new MyInstantsProvider(mockFetch);
    const resolved = await provider.resolve(
      "https://www.myinstants.com/es/instant/gi-steel-pipe-91047?utm_source=copy&utm_medium=share"
    );
    expect(requestedUrls[0]).toBe("https://www.myinstants.com/es/instant/gi-steel-pipe-91047/");
    expect(resolved.page_url).toBe("https://www.myinstants.com/es/instant/gi-steel-pipe-91047/");
    expect(resolved.media_url).toBe("https://www.myinstants.com/media/sounds/gi-steel-pipe.mp3");
    expect(resolved.title).toBe("gi steel pipe");
    expect(resolved.bytes).toEqual(mp3Stub);
  });

  it("search() lists sounds from a results page: dedupes, decodes titles, skips off-site media, builds index/search URLs", async () => {
    const item = (media: string, title: string) =>
      `<div class="instant"><button class="small-button" onclick="play('${media}', 'loader-1', 'x-1')"></button>` +
      `<a href="/es/instant/x-1/" class="instant-link link-secondary">${title}</a></div>`;
    const listHtml =
      item("/media/sounds/bruh.mp3", "Bruh &amp; co") +
      item("/media/sounds/bruh.mp3", "Bruh duplicate") +
      item("/media/sounds/faaah.mp3", "FAAAH") +
      `<button onclick="play('//evil.example/media/sounds/x.mp3')"></button>`;
    const requestedUrls: string[] = [];
    const mockFetch: FetchLike = async (url) => {
      requestedUrls.push(String(url));
      return new Response(listHtml, { status: 200 });
    };
    const provider = new MyInstantsProvider(mockFetch);

    expect(await provider.search("  bruh moment ", 2)).toEqual([
      { title: "Bruh & co", media_url: "https://www.myinstants.com/media/sounds/bruh.mp3" },
      { title: "FAAAH", media_url: "https://www.myinstants.com/media/sounds/faaah.mp3" }
    ]);
    await provider.search("");
    expect(requestedUrls).toEqual([
      "https://www.myinstants.com/es/search/?name=bruh%20moment&page=2",
      "https://www.myinstants.com/es/index/es/?page=1"
    ]);
  });
});
