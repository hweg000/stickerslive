import { useEffect, useState } from "react";
import { IconClose } from "./icons";

export interface TourStep {
  icon: string;
  title: string;
  text: string;
  /** Optional external link shown under the text (opens in a new tab). */
  link?: { href: string; label: string };
}

export interface TourProps {
  steps: TourStep[];
  onClose(): void;
  labels: { title: string; next: string; back: string; skip: string; done: string };
}

const SEEN_KEY = "sticksound.tourSeen";

// Browser storage can throw (private mode, blocked site data): the tour then just shows again.
export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // ignore
  }
}

/** Short step-by-step "how to use" dialog. */
export const Tour = ({ steps, onClose, labels }: TourProps) => {
  const [index, setIndex] = useState(0);
  const step = steps[index]!;
  const isLast = index === steps.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setIndex((i) => Math.min(steps.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, steps.length]);

  return (
    <div className="stik-modal-backdrop" onClick={onClose}>
      <div
        className="stik-modal stik-tour"
        data-testid="tour"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stik-tour-step-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="stik-sound-browser-head">
          <span className="stik-tour-kicker">
            {labels.title} · {index + 1}/{steps.length}
          </span>
          <button type="button" className="stik-corner-btn" aria-label={labels.skip} onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="stik-tour-icon" aria-hidden="true">
          {step.icon}
        </div>
        <h3 id="stik-tour-step-title" className="stik-tour-title">
          {step.title}
        </h3>
        <p className="stik-tour-text" data-testid="tour-text">
          {step.text}
        </p>
        {step.link && (
          <a className="stik-tour-link" data-testid="tour-link" href={step.link.href} target="_blank" rel="noopener noreferrer">
            {step.link.label} ↗
          </a>
        )}

        <div className="stik-tour-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <span key={i} className={i === index ? "active" : ""} />
          ))}
        </div>

        <div className="stik-tour-actions">
          {index > 0 ? (
            <button type="button" className="stik-pill-btn stik-secondary-btn" onClick={() => setIndex(index - 1)}>
              {labels.back}
            </button>
          ) : (
            <button type="button" className="stik-link-btn" onClick={onClose}>
              {labels.skip}
            </button>
          )}
          <button
            type="button"
            data-testid="tour-next"
            className="stik-pill-btn stik-pill-accent"
            autoFocus
            onClick={() => (isLast ? onClose() : setIndex(index + 1))}
          >
            {isLast ? labels.done : labels.next}
          </button>
        </div>
      </div>
    </div>
  );
};
