import { useEffect, useRef, useState } from "react";
import { IconClose, IconPlay, IconSpinner, IconStop } from "./icons";

// On phones, focusing the search box on open pops the keyboard over the results.
const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

// A pasted MyInstants link is imported directly (the provider validates it) instead of searched.
const MYINSTANTS_LINK = /^https?:\/\/(www\.)?myinstants\.com\//i;

export interface SoundSearchResult {
  title: string;
  media_url: string;
}

export type SoundSearchFn = (query: string, page: number) => Promise<SoundSearchResult[]>;

export interface SoundBrowserProps {
  search: SoundSearchFn;
  onPick(mediaUrl: string): void;
  onClose(): void;
  labels: {
    title: string;
    placeholder: string;
    use: string;
    empty: string;
    more: string;
    error: string;
    play: string;
    stop: string;
    close: string;
  };
}

export const SoundBrowser = ({ search, onPick, onClose, labels }: SoundBrowserProps) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SoundSearchResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestId = useRef(0);
  const lastQuery = useRef("");

  const load = async (q: string, nextPage: number) => {
    const id = ++requestId.current;
    lastQuery.current = q;
    setLoading(true);
    setFailed(false);
    try {
      const items = await search(q, nextPage);
      if (id !== requestId.current) return; // a newer search replaced this one
      setResults((prev) => {
        if (nextPage === 1) return items;
        const known = new Set(prev.map((r) => r.media_url));
        return [...prev, ...items.filter((r) => !known.has(r.media_url))];
      });
      setPage(nextPage);
      setHasMore(items.length > 0);
    } catch {
      if (id !== requestId.current) return;
      if (nextPage === 1) setResults([]);
      // A page past the end comes back as an error; just stop offering more.
      if (nextPage > 1) setHasMore(false);
      else setFailed(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load("", 1);
    return () => audioRef.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePreview = (url: string) => {
    audioRef.current?.pause();
    if (playingUrl === url) {
      setPlayingUrl(null);
      return;
    }
    // <audio> may play cross-origin media without CORS, so preview needs no proxy.
    const audio = new Audio(url);
    audio.onended = () => setPlayingUrl((cur) => (cur === url ? null : cur));
    audio.play().catch(() => setPlayingUrl(null));
    audioRef.current = audio;
    setPlayingUrl(url);
  };

  return (
    <div className="stik-modal-backdrop" onClick={onClose}>
      <div
        className="stik-modal stik-sound-browser"
        data-testid="sound-browser"
        role="dialog"
        aria-label={labels.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="stik-sound-browser-head">
          <h3>{labels.title}</h3>
          <button type="button" className="stik-corner-btn" aria-label={labels.close} onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = query.trim();
            if (MYINSTANTS_LINK.test(q)) {
              audioRef.current?.pause();
              onPick(q);
              return;
            }
            void load(q, 1);
          }}
        >
          <input
            type="search"
            className="stik-url-input stik-sound-search"
            data-testid="sound-search-input"
            placeholder={labels.placeholder}
            value={query}
            autoFocus={!isTouch}
            onChange={(e) => setQuery(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text/plain").trim();
              if (MYINSTANTS_LINK.test(text)) {
                e.preventDefault();
                audioRef.current?.pause();
                onPick(text);
              }
            }}
          />
        </form>

        <ul className="stik-sound-list">
          {results.map((r) => (
            <li key={r.media_url} className="stik-sound-item">
              <button
                type="button"
                className="stik-play-btn"
                aria-label={`${playingUrl === r.media_url ? labels.stop : labels.play}: ${r.title}`}
                onClick={() => togglePreview(r.media_url)}
              >
                {playingUrl === r.media_url ? <IconStop /> : <IconPlay />}
              </button>
              <span className="stik-sound-title" title={r.title}>
                {r.title}
              </span>
              <button
                type="button"
                className="stik-pill-btn stik-pill-accent"
                data-testid="sound-use-btn"
                onClick={() => {
                  audioRef.current?.pause();
                  onPick(r.media_url);
                }}
              >
                {labels.use}
              </button>
            </li>
          ))}
        </ul>

        {loading && (
          <div className="stik-sound-status">
            <IconSpinner />
          </div>
        )}
        {!loading && failed && <p className="stik-sound-status">{labels.error}</p>}
        {!loading && !failed && results.length === 0 && <p className="stik-sound-status">{labels.empty}</p>}
        {!loading && !failed && results.length > 0 && hasMore && (
          <button type="button" className="stik-pill-btn" onClick={() => void load(lastQuery.current, page + 1)}>
            {labels.more}
          </button>
        )}
      </div>
    </div>
  );
};
