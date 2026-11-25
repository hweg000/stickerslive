import React, { useMemo, useRef } from "react";
import { LIMITS, type PeakBuckets } from "@stiksound/core";
import { IconPlay, IconStop } from "./icons";

export interface TimelineTrimBarProps {
  hasAudio: boolean;
  durationMs: number;
  startMs: number;
  endMs: number;
  maxWindowMs?: number;
  peaks: PeakBuckets | null;
  isPlaying: boolean;
  isBusy: boolean;
  /** Hide the MyInstants URL field and show only the file button. Default true. */
  showUrlInput?: boolean;
  urlInput: string;
  onUrlInputChange: (value: string) => void;
  onSubmitUrl: (url: string) => void;
  onSelectAudioFile: (file: File) => void;
  onChangeRange: (startMs: number, endMs: number) => void;
  onChangeMaxWindowMs?: (maxMs: 5000 | 10000) => void;
  onTogglePlay: () => void;
  /** Opens the sound browser; the button is hidden when not set. */
  onBrowseSounds?: () => void;
  /** Microphone recording; the button is hidden when not set (no mic API). */
  recording?: { active: boolean; elapsedMs: number; onToggle: () => void };
  labels: {
    placeholder: string;
    pickBtn: string;
    play: string;
    stop: string;
    maxDurationAria?: string;
    browseBtn?: string;
    recordBtn?: string;
    recordStop?: string;
  };
}

function formatSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export const TimelineTrimBar: React.FC<TimelineTrimBarProps> = ({
  hasAudio,
  durationMs,
  startMs,
  endMs,
  maxWindowMs = LIMITS.DEFAULT_VIDEO_MAX_AUDIO_MS,
  peaks,
  isPlaying,
  isBusy,
  showUrlInput = true,
  urlInput,
  onUrlInputChange,
  onSubmitUrl,
  onSelectAudioFile,
  onChangeRange,
  onChangeMaxWindowMs,
  onTogglePlay,
  onBrowseSounds,
  recording,
  labels
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const selectedMs = Math.max(0, endMs - startMs);
  const fullWindowMs = Math.min(maxWindowMs, durationMs);
  const hasPartialTrim = selectedMs >= LIMITS.MIN_TRIM_DURATION_MS && selectedMs < fullWindowMs;
  const activeWindowMs = hasPartialTrim ? selectedMs : fullWindowMs;
  const maxStartMs = Math.max(0, durationMs - activeWindowMs);
  const boundedStartMs = Math.max(0, Math.min(startMs, maxStartMs));
  const windowLeftPct = durationMs > 0 ? (startMs / durationMs) * 100 : 0;
  const windowWidthPct = durationMs > 0 ? ((endMs - startMs) / durationMs) * 100 : 100;

  const downsampledBars = useMemo(() => {
    const count = 48;
    if (!peaks || peaks.buckets === 0) {
      return Array.from({ length: count }, () => 0.35);
    }
    const bars: number[] = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.min(peaks.buckets - 1, Math.floor((i * peaks.buckets) / count));
      const amp = Math.max(Math.abs(peaks.mins[idx] ?? 0), Math.abs(peaks.maxs[idx] ?? 0));
      bars.push(Math.max(0.12, Math.min(1, amp)));
    }
    return bars;
  }, [peaks]);

  const handleTrackPointer = (clientX: number) => {
    if (!trackRef.current || durationMs <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (activeWindowMs <= 0) return;
    const clickedMs = Math.round(ratio * durationMs);
    const nextStart = Math.max(0, Math.min(maxStartMs, Math.round(clickedMs - activeWindowMs / 2)));
    onChangeRange(nextStart, nextStart + activeWindowMs);
  };

  const renderDurationSwitch = () => {
    if (!onChangeMaxWindowMs) return null;
    return (
      <div
        className="stik-duration-switch"
        data-testid="max-duration-switch"
        role="group"
        aria-label={labels.maxDurationAria ?? "Max duration"}
      >
        {LIMITS.AUDIO_DURATION_PRESETS.map((presetMs) => {
          const active = maxWindowMs === presetMs;
          const labelSec = `${presetMs / 1000}s`;
          return (
            <button
              key={presetMs}
              type="button"
              data-testid={`max-duration-${labelSec}`}
              aria-pressed={active}
              className={`stik-duration-switch-btn ${active ? "active" : ""}`}
              disabled={isBusy}
              onClick={() => onChangeMaxWindowMs(presetMs)}
            >
              {labelSec}
            </button>
          );
        })}
      </div>
    );
  };

  const recordButton = recording && (
    <button
      type="button"
      data-testid="record-audio-btn"
      className={`stik-pill-btn stik-record-btn${recording.active ? " recording" : ""}`}
      disabled={isBusy && !recording.active}
      aria-pressed={recording.active}
      onClick={recording.onToggle}
    >
      {recording.active ? `${labels.recordStop ?? "Stop"} ${formatSec(recording.elapsedMs)}` : labels.recordBtn ?? "Record"}
    </button>
  );

  return (
    <div
      data-testid="timeline-bar"
      className="stik-timeline-bar"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) onSelectAudioFile(file);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onSelectAudioFile(f);
          e.target.value = "";
        }}
      />

      {!hasAudio ? (
        <form
          className="stik-audio-empty-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (urlInput.trim()) onSubmitUrl(urlInput.trim());
          }}
        >
          {onBrowseSounds && (
            // Row 1: the two ways to get a new sound. The sound browser also accepts pasted links,
            // so the URL field is only shown on shells without it.
            <div className="stik-audio-row">
              <button
                type="button"
                data-testid="browse-sounds-btn"
                className="stik-pill-btn stik-pill-accent stik-browse-btn"
                disabled={isBusy}
                onClick={onBrowseSounds}
              >
                {labels.browseBtn ?? "MyInstants"}
              </button>
              {recordButton}
            </div>
          )}
          {showUrlInput && !onBrowseSounds && (
            <input
              type="url"
              data-testid="myinstants-url-input"
              className="stik-url-input"
              value={urlInput}
              disabled={isBusy}
              placeholder={labels.placeholder}
              onChange={(e) => onUrlInputChange(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text/plain").trim();
                if (/^https?:\/\//i.test(text)) {
                  e.preventDefault();
                  onUrlInputChange(text);
                  onSubmitUrl(text);
                }
              }}
            />
          )}
          <div className="stik-audio-row">
            <button
              type="button"
              data-testid="audio-pick-btn"
              className={`stik-pill-btn${showUrlInput ? "" : " stik-pill-wide"}`}
              disabled={isBusy}
              onClick={() => fileRef.current?.click()}
            >
              {labels.pickBtn}
            </button>
            {!onBrowseSounds && recordButton}
            {renderDurationSwitch()}
          </div>
        </form>
      ) : (
        <div className="stik-timeline-active">
          <button
            type="button"
            data-testid="play-preview-btn"
            className="stik-play-btn"
            aria-label={isPlaying ? labels.stop : labels.play}
            onClick={onTogglePlay}
          >
            {isPlaying ? <IconStop /> : <IconPlay />}
          </button>

          <div
            ref={trackRef}
            data-testid="waveform-track"
            className="stik-waveform-track"
            onClick={(e) => handleTrackPointer(e.clientX)}
          >
            <div className="stik-waveform-bars">
              {downsampledBars.map((amp, i) => (
                <span
                  key={i}
                  className="stik-waveform-bar"
                  style={{ height: `${Math.round(amp * 100)}%` }}
                />
              ))}
            </div>
            <div
              data-testid="trim-window"
              className="stik-trim-window"
              style={{
                left: `${windowLeftPct}%`,
                width: `${Math.max(4, windowWidthPct)}%`
              }}
            />
          </div>

          {activeWindowMs > 0 && durationMs > activeWindowMs && (
            <input
              type="range"
              data-testid="trim-slider"
              aria-label={`${formatSec(activeWindowMs)} window position`}
              className="stik-trim-slider"
              min={0}
              max={maxStartMs}
              step={1}
              value={boundedStartMs}
              onChange={(e) => {
                const nextStart = Number(e.target.value);
                onChangeRange(nextStart, nextStart + activeWindowMs);
              }}
            />
          )}

          <span data-testid="duration-readout" className="stik-duration-pill">
            {formatSec(selectedMs)} / {formatSec(maxWindowMs)}
          </span>
          {renderDurationSwitch()}
        </div>
      )}
    </div>
  );
};
