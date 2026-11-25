import { describe, expect, it } from "vitest";
import { encodeWavMono, mixToMono } from "../src/components/recording";

describe("microphone recording helpers", () => {
  it("encodes 16-bit mono PCM WAV with a correct RIFF header and clamped samples", () => {
    const wav = encodeWavMono(new Float32Array([0, 1, -1, 2]), 48000);
    const v = new DataView(wav.buffer);
    const ascii = (off: number) => String.fromCharCode(...wav.slice(off, off + 4));
    expect(wav.byteLength).toBe(44 + 4 * 2);
    expect(ascii(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(ascii(8)).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(96000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });

  it("mixes stereo down to mono by averaging and passes mono through", () => {
    const mono = new Float32Array([0.5, -0.5]);
    expect(mixToMono([mono])).toBe(mono);
    expect([...mixToMono([new Float32Array([1, 0]), new Float32Array([0, -1])])]).toEqual([0.5, -0.5]);
  });
});
