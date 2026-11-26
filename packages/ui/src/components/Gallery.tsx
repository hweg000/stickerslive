import { useEffect, useState } from "react";
import type { ExportArtifact, RgbaFrame512 } from "@stiksound/core";
import { IconClose, IconSpinner } from "./icons";

export interface GalleryItem {
  id: string;
  author: string | null;
  title: string | null;
  createdAt: string;
}

/** Community gallery backend, provided by the shell (web: Netlify Functions). */
export interface GalleryClient {
  list(): Promise<GalleryItem[]>;
  mediaUrl(id: string, kind: "video" | "thumb"): string;
  /** Sends the export for review; nothing is public until the admin approves it. */
  submit(input: {
    video: ExportArtifact;
    thumb: RgbaFrame512;
    /** Painted behind transparent pixels of the thumbnail. */
    thumbBackground: string;
    author: string;
    title: string;
  }): Promise<void>;
  report(id: string): Promise<void>;
}

export interface GalleryLabels {
  title: string;
  empty: string;
  error: string;
  anonymous: string;
  report: string;
  reported: string;
  download: string;
  back: string;
  close: string;
  publishTitle: string;
  publishAuthor: string;
  publishAuthorHint: string;
  publishName: string;
  publishConsent: string;
  publishSend: string;
  publishSent: string;
  publishError: string;
  publishRateLimited: string;
  publishTooBig: string;
}

const Modal = ({ children, onClose, label, testId }: { children: React.ReactNode; onClose(): void; label: string; testId: string }) => (
  <div className="stik-modal-backdrop" onClick={onClose}>
    <div
      className="stik-modal stik-sound-browser"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  </div>
);

const Head = ({ title, onClose, closeLabel }: { title: string; onClose(): void; closeLabel: string }) => (
  <div className="stik-sound-browser-head">
    <h3>{title}</h3>
    <button type="button" className="stik-corner-btn" aria-label={closeLabel} onClick={onClose}>
      <IconClose />
    </button>
  </div>
);

/** Optional name + consent, then sends the export to the review queue. */
export const PublishDialog = ({
  onSubmit,
  onClose,
  labels
}: {
  onSubmit(author: string, title: string): Promise<void>;
  onClose(): void;
  labels: GalleryLabels;
}) => {
  const [author, setAuthor] = useState("");
  const [title, setTitle] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error" | "limited" | "tooBig">("idle");

  return (
    <Modal onClose={onClose} label={labels.publishTitle} testId="publish-dialog">
      <Head title={labels.publishTitle} onClose={onClose} closeLabel={labels.close} />
      {state === "sent" ? (
        <p className="stik-tour-text" data-testid="publish-sent">
          {labels.publishSent}
        </p>
      ) : (
        <form
          className="stik-publish-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!consent || state === "sending") return;
            setState("sending");
            try {
              await onSubmit(author, title);
              setState("sent");
            } catch (err) {
              const status = (err as { status?: number })?.status;
              setState(status === 429 ? "limited" : status === 413 ? "tooBig" : "error");
            }
          }}
        >
          <label className="stik-popover-label">
            {labels.publishAuthor}
            <input
              className="stik-url-input"
              data-testid="publish-author"
              maxLength={30}
              placeholder={labels.publishAuthorHint}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
          </label>
          <label className="stik-popover-label">
            {labels.publishName}
            <input
              className="stik-url-input"
              data-testid="publish-title"
              maxLength={60}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="stik-consent">
            <input type="checkbox" data-testid="publish-consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{labels.publishConsent}</span>
          </label>
          {state === "error" && <p className="stik-toast error">{labels.publishError}</p>}
          {state === "limited" && <p className="stik-toast error">{labels.publishRateLimited}</p>}
          {state === "tooBig" && <p className="stik-toast error">{labels.publishTooBig}</p>}
          <button
            type="submit"
            data-testid="publish-send"
            className="stik-pill-btn stik-pill-accent"
            disabled={!consent || state === "sending"}
          >
            {state === "sending" ? <IconSpinner /> : labels.publishSend}
          </button>
        </form>
      )}
    </Modal>
  );
};

/** Approved community stickers: light thumbnails in a grid; the video loads only when opened. */
export const GalleryBrowser = ({ client, onClose, labels }: { client: GalleryClient; onClose(): void; labels: GalleryLabels }) => {
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<GalleryItem | null>(null);
  const [reported, setReported] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    client
      .list()
      .then((list) => alive && setItems(list))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [client]);

  const name = (it: GalleryItem) => it.author ?? labels.anonymous;

  return (
    <Modal onClose={onClose} label={labels.title} testId="gallery">
      <Head title={labels.title} onClose={onClose} closeLabel={labels.close} />
      {open ? (
        <div className="stik-gallery-detail">
          <video
            className="stik-gallery-video"
            data-testid="gallery-video"
            src={client.mediaUrl(open.id, "video")}
            poster={client.mediaUrl(open.id, "thumb")}
            controls
            autoPlay
            loop
            playsInline
          />
          <p className="stik-gallery-caption">
            {open.title && <strong>{open.title} · </strong>}
            {name(open)}
          </p>
          <div className="stik-ready-actions">
            <a className="stik-pill-btn" href={client.mediaUrl(open.id, "video")} download>
              {labels.download}
            </a>
            <button
              type="button"
              data-testid="gallery-report"
              className="stik-pill-btn stik-secondary-btn"
              disabled={reported.has(open.id)}
              onClick={async () => {
                try {
                  await client.report(open.id);
                } finally {
                  setReported((s) => new Set(s).add(open.id));
                }
              }}
            >
              {reported.has(open.id) ? labels.reported : labels.report}
            </button>
            <button type="button" className="stik-pill-btn stik-secondary-btn" onClick={() => setOpen(null)}>
              {labels.back}
            </button>
          </div>
        </div>
      ) : failed ? (
        <p className="stik-sound-status">{labels.error}</p>
      ) : items === null ? (
        <div className="stik-sound-status">
          <IconSpinner />
        </div>
      ) : items.length === 0 ? (
        <p className="stik-sound-status">{labels.empty}</p>
      ) : (
        <div className="stik-gif-grid">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className="stik-gif-item stik-gallery-item"
              data-testid="gallery-item"
              title={it.title ? `${it.title} · ${name(it)}` : name(it)}
              onClick={() => setOpen(it)}
            >
              <img src={client.mediaUrl(it.id, "thumb")} alt={it.title ?? name(it)} loading="lazy" />
              <span className="stik-gallery-author">{name(it)}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
};
