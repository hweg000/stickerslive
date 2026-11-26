import { useEffect, useRef, useState } from "react";
import { IconClose, IconSpinner } from "./icons";

// On phones, focusing the search box on open pops the keyboard over the results.
const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

export interface GifSearchResult {
  title: string;
  preview_url: string;
  gif_url: string;
  width?: number;
  height?: number;
  provider?: "klipy" | "tenor";
  small_url?: string;
}

export interface GifSource {
  search(query: string): Promise<GifSearchResult[]>;
  download(gif: GifSearchResult): Promise<Uint8Array>;
  /** Search box text required by the provider (KLIPY: "Search KLIPY"); falls back to the label. */
  placeholder?: string;
}

/** Provider attribution under the results (KLIPY terms require visible attribution). */
const ATTRIBUTION: Record<"klipy" | "tenor", string> = { klipy: "Powered by KLIPY", tenor: "via Tenor" };

export interface GifBrowserProps {
  search: GifSource["search"];
  onPick(gif: GifSearchResult): void;
  onClose(): void;
  labels: { title: string; placeholder: string; empty: string; error: string; close: string };
}

export const GifBrowser = ({ search, onPick, onClose, labels }: GifBrowserProps) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  const load = async (q: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setFailed(false);
    try {
      const items = await search(q);
      if (id === requestId.current) setResults(items);
    } catch {
      if (id === requestId.current) {
        setResults([]);
        setFailed(true);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="stik-modal-backdrop" onClick={onClose}>
      <div
        className="stik-modal stik-sound-browser"
        data-testid="gif-browser"
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
            void load(query);
          }}
        >
          <input
            type="search"
            className="stik-url-input stik-sound-search"
            data-testid="gif-search-input"
            placeholder={labels.placeholder}
            value={query}
            autoFocus={!isTouch}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>

        {!loading && results.length > 0 && (
          // Scroll lives on the wrapper: a height-capped multi-column box would overflow sideways.
          <div className="stik-gif-scroll">
            <div className="stik-gif-grid">
              {results.map((g) => (
                <button
                  key={g.preview_url}
                  type="button"
                  className="stik-gif-item"
                  data-testid="gif-item"
                  title={g.title}
                  onClick={() => onPick(g)}
                >
                  <img
                    src={g.preview_url}
                    alt={g.title}
                    loading="lazy"
                    // Reserve the GIF's real shape before it loads, so the columns don't jump.
                    style={g.width && g.height ? { aspectRatio: `${g.width} / ${g.height}` } : undefined}
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        {loading && (
          <div className="stik-sound-status">
            <IconSpinner />
          </div>
        )}
        {!loading && failed && <p className="stik-sound-status">{labels.error}</p>}
        {!loading && !failed && results.length === 0 && <p className="stik-sound-status">{labels.empty}</p>}
        {!loading && results[0]?.provider && (
          <p className="stik-gif-attribution" data-testid="gif-attribution">
            {ATTRIBUTION[results[0].provider]}
          </p>
        )}
      </div>
    </div>
  );
};
