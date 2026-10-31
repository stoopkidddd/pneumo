import { isUuidv7 } from "@pneumo/protocol";
import { useEffect, useRef, useState } from "react";
import { HistoryRow } from "../history/HistoryRow.js";
import { ErrorNotice } from "../views/fields.js";
import { Composer } from "./Composer.js";
import type { HomeState } from "./useHome.js";
import "./home.css";

export function HomeView({ state }: { state: HomeState }) {
  const [selected, setSelected] = useState(() =>
    new URLSearchParams(window.location.search).get("push"),
  );
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [findAttempt, setFindAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const sentinel = useRef<HTMLDivElement>(null);
  const found = state.items.some((item) => item.id === selected);
  const { find, more, loading, loadingMore, nextBefore, error } = state;

  useEffect(() => {
    const changed = () => setSelected(new URLSearchParams(window.location.search).get("push"));
    window.addEventListener("popstate", changed);
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => {
      window.removeEventListener("popstate", changed);
      clearInterval(timer);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry repeats the lookup for the same push id.
  useEffect(() => {
    if (!selected || loading || found) return;
    let active = true;
    setDeepLinkError(null);
    if (!isUuidv7(selected)) {
      setDeepLinkError("This push link is not valid.");
      return;
    }
    void find(selected).catch(() => {
      if (active)
        setDeepLinkError(
          "Could not open this push. It may have been deleted, or your connection is unavailable.",
        );
    });
    return () => {
      active = false;
    };
  }, [selected, loading, found, find, findAttempt]);
  useEffect(() => {
    if (!nextBefore || loadingMore || error || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void more();
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [nextBefore, loadingMore, error, more]);

  return (
    <div className="home-surface">
      <div className="home-heading">
        <h1>Home</h1>
        <p className="connection-state" role="status">
          <span
            className={`connection-dot${!state.offline && state.live === "connected" ? " online" : ""}`}
            aria-hidden="true"
          />
          {state.offline ? "Offline" : state.live === "connected" ? "Live" : "Reconnecting…"}
        </p>
      </div>
      {state.offline && (
        <p className="offline-banner" role="status">
          Offline. Your loaded history is still here. Sending and live updates resume when you
          reconnect.
        </p>
      )}
      <Composer
        devices={state.devices}
        maxEnvelopeBytes={state.maxEnvelopeBytes}
        offline={state.offline || state.maxEnvelopeBytes === 0}
        onSend={state.send}
      />
      <section className="history-section" aria-labelledby="history-heading">
        <div className="history-heading">
          <h2 id="history-heading">History</h2>
          <span className="muted">Newest first</span>
        </div>
        {error && (
          <div>
            <ErrorNotice>{error}</ErrorNotice>
            <button type="button" onClick={state.retry}>
              Try again
            </button>
          </div>
        )}
        {deepLinkError && !found && (
          <div>
            <ErrorNotice>{deepLinkError}</ErrorNotice>
            <button type="button" onClick={() => setFindAttempt((attempt) => attempt + 1)}>
              Retry opening push
            </button>
          </div>
        )}
        {loading && <p role="status">Loading history…</p>}
        {!loading && !error && state.items.length === 0 && (
          <div className="history-empty">
            <h3>Nothing here yet.</h3>
            <p className="muted">Send yourself something.</p>
          </div>
        )}
        <div className="history-list">
          {state.items.map((item) => (
            <HistoryRow
              key={item.id}
              item={item}
              devices={state.devices}
              highlighted={selected === item.id}
              now={now}
              onDelete={state.remove}
            />
          ))}
        </div>
        {nextBefore && (
          <div ref={sentinel} className="history-pagination">
            <button
              type="button"
              disabled={loadingMore || state.offline}
              onClick={() => void more()}
            >
              {loadingMore ? "Loading older pushes…" : "Load older pushes"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
