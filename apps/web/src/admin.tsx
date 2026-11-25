import { useEffect, useState } from "react";

/**
 * Gallery moderation, opened at /#admin. Uses the ADMIN_PASSWORD set in Netlify
 * (Site configuration → Environment variables). The password is only kept for this tab.
 */

interface Meta {
  id: string;
  status: "pending" | "approved" | "reported";
  author: string | null;
  title: string | null;
  createdAt: string;
}
type Queue = { pending: Meta[]; reported: Meta[]; approved: Meta[] };

const API = "/api/gallery";
const PW_KEY = "sticksound.adminPassword";

function readPw(): string {
  try {
    return sessionStorage.getItem(PW_KEY) ?? "";
  } catch {
    return "";
  }
}
function savePw(pw: string): void {
  try {
    sessionStorage.setItem(PW_KEY, pw);
  } catch {
    // ignore: the password just is not remembered
  }
}

/** Pending media is not public, so it is fetched with the password and shown from a blob URL. */
function AuthedMedia({ id, kind, pw }: { id: string; kind: "video" | "thumb"; pw: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    fetch(`${API}/media/${id}/${kind}`, { headers: { authorization: `Bearer ${pw}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b || !alive) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, kind, pw]);
  if (!url) return <div className="stik-admin-media stik-admin-loading" />;
  return kind === "video" ? (
    <video className="stik-admin-media" src={url} controls loop playsInline />
  ) : (
    <img className="stik-admin-media" src={url} alt="" />
  );
}

export function AdminApp() {
  const [pw, setPw] = useState(readPw);
  const [input, setInput] = useState("");
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = async (password: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/admin`, { headers: { authorization: `Bearer ${password}` } });
      if (res.status === 401) throw new Error("Contraseña incorrecta.");
      if (res.status === 429) throw new Error("Demasiados intentos fallidos. Espera una hora.");
      if (res.status === 503) throw new Error("Falta crear ADMIN_PASSWORD en Netlify (Site configuration → Environment variables) y volver a publicar.");
      if (!res.ok) throw new Error(`Error ${res.status}. ¿Están publicadas las funciones de Netlify?`);
      setQueue((await res.json()) as Queue);
      setPw(password);
      savePw(password);
    } catch (e) {
      setQueue(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (pw) void load(pw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (id: string, action: "approve" | "hide" | "delete") => {
    if (action === "delete" && !window.confirm("¿Borrar este sticker para siempre?")) return;
    setBusy(true);
    const res = await fetch(`${API}/admin/${id}/${action}`, { method: "POST", headers: { authorization: `Bearer ${pw}` } });
    if (!res.ok) setError(`No se pudo (${res.status}).`);
    await load(pw);
  };

  if (!queue) {
    return (
      <div className="stik-admin">
        <h1>Moderación de la galería</h1>
        <form
          className="stik-publish-form"
          onSubmit={(e) => {
            e.preventDefault();
            void load(input);
          }}
        >
          <input
            className="stik-url-input"
            type="password"
            autoComplete="current-password"
            placeholder="Contraseña de administrador"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="stik-pill-btn stik-pill-accent" disabled={busy || !input}>
            Entrar
          </button>
          {error && <p className="stik-toast error">{error}</p>}
        </form>
        <p className="stik-admin-hint">
          <a href="./">← Volver a la app</a>
        </p>
      </div>
    );
  }

  const section = (title: string, items: Meta[], actions: Array<["approve" | "hide" | "delete", string]>) => (
    <section>
      <h2>
        {title} ({items.length})
      </h2>
      {items.length === 0 && <p className="stik-admin-hint">Nada por aquí.</p>}
      <div className="stik-admin-grid">
        {items.map((m) => (
          <div key={m.id} className="stik-admin-card">
            <button type="button" className="stik-admin-play" onClick={() => setPlaying(playing === m.id ? null : m.id)}>
              <AuthedMedia id={m.id} kind={playing === m.id ? "video" : "thumb"} pw={pw} />
            </button>
            <p>
              <strong>{m.title ?? "(sin título)"}</strong>
              <br />
              {m.author ?? "Anónimo"} · {new Date(m.createdAt).toLocaleString()}
            </p>
            <div className="stik-ready-actions">
              {actions.map(([a, label]) => (
                <button
                  key={a}
                  type="button"
                  disabled={busy}
                  className={`stik-pill-btn ${a === "approve" ? "stik-pill-accent" : "stik-secondary-btn"}`}
                  onClick={() => void act(m.id, a)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div className="stik-admin">
      <h1>Moderación de la galería</h1>
      <p className="stik-admin-hint">
        Toca una miniatura para ver el video. <a href="./">← Volver a la app</a>
      </p>
      {error && <p className="stik-toast error">{error}</p>}
      {section("Pendientes de revisión", queue.pending, [
        ["approve", "✅ Aprobar"],
        ["delete", "🗑️ Borrar"]
      ])}
      {section("Reportados (ocultos)", queue.reported, [
        ["approve", "↩️ Volver a publicar"],
        ["delete", "🗑️ Borrar"]
      ])}
      {section("Publicados", queue.approved, [
        ["hide", "🙈 Ocultar"],
        ["delete", "🗑️ Borrar"]
      ])}
    </div>
  );
}
