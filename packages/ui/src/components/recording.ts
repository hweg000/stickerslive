/**
 * Microphone recording for the audio bar.
 * Browsers record different containers (Chrome: WebM/Opus, Safari: MP4/AAC) and the project
 * only accepts mp3/wav/ogg/m4a/aac, so the take is decoded and re-encoded as 16-bit mono WAV,
 * which every engine path (web, desktop, package schema) already handles.
 */

/** A sticker sound is 5-10 s; 30 s leaves room to trim. 30 s of 48 kHz mono WAV is ~2.9 MB. */
export const MAX_RECORDING_MS = 30_000;

export function canRecordAudio(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined"
  );
}

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (const ch of channels) {
    for (let i = 0; i < length; i++) out[i]! += ch[i]! / channels.length;
  }
  return out;
}

/** 16-bit PCM mono WAV (RIFF/WAVE, 44-byte header). */
export function encodeWavMono(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export interface ActiveRecording {
  /** Stops and returns the take as WAV bytes. */
  stop(): Promise<Uint8Array>;
  /** Stops and discards (e.g. on unmount). */
  cancel(): void;
}

/** Asks for the microphone and starts recording. Rejects if permission is denied. */
export async function startRecording(): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (err) {
    release();
    throw err;
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();

  return {
    async stop() {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      release();
      const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
      const ctx = new AudioContext();
      try {
        const audio = await ctx.decodeAudioData(encoded);
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        return encodeWavMono(mixToMono(channels), audio.sampleRate);
      } finally {
        await ctx.close().catch(() => undefined);
      }
    },
    cancel() {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    }
  };
}
