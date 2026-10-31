import type { DeviceDTO } from "@pneumo/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createApiClient } from "./api/client.js";
import { DevicesView } from "./devices/DevicesView.js";
import { HomeView } from "./home/HomeView.js";
import { useHome } from "./home/useHome.js";
import { Link } from "./Link.js";
import { clear, load, type Session } from "./session/store.js";
import { AuthView } from "./views/AuthView.js";
import { ErrorNotice } from "./views/fields.js";
import { SettingsView } from "./views/SettingsView.js";

function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.replaceState(null, "", path + (path === "/setup" ? window.location.hash : ""));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [session, setSession] = useState<Session | null>(null);
  const [device, setDevice] = useState<DeviceDTO | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const signingOut = useRef(false);
  const unauthorized = useCallback(
    async (reason = "Your session is no longer valid. Sign in again.") => {
      await clear();
      setSession((current) => {
        current?.mk.fill(0);
        return null;
      });
      setDevice(null);
      if (window.location.pathname !== "/login") {
        setMessage(signingOut.current ? "You have signed out of this browser." : reason);
      }
      navigate("/login");
    },
    [],
  );
  const [api] = useState(() => createApiClient({ onUnauthorized: unauthorized }));
  const removed = useCallback(() => {
    void unauthorized("This browser was removed from Pneumo.");
  }, [unauthorized]);
  const home = useHome(api, session, removed);
  const currentDevice = home.devices.find((item) => item.id === session?.deviceId) ?? device;

  const signedOut = () => {
    session?.mk.fill(0);
    setSession(null);
    setDevice(null);
    setMessage("You have signed out of this browser.");
    navigate("/login");
  };

  async function removeSelf() {
    if (!session) return;
    signingOut.current = true;
    try {
      await api.request("deleteDevice", { params: { id: session.deviceId } });
      await clear();
      signedOut();
    } finally {
      signingOut.current = false;
    }
  }

  useEffect(() => {
    const changed = () => setPath(window.location.pathname);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setError(null);
      try {
        const [health, stored] = await Promise.all([api.request("health"), load()]);
        if (cancelled) return;
        setInitialized(health.initialized);
        if (!health.initialized) {
          await clear();
        } else if (stored) {
          const me = await api.request("me");
          if (cancelled) return;
          setSession(stored);
          setDevice(me.device);
        }
      } catch (failure) {
        if (!cancelled && !(failure instanceof ApiError && failure.status === 401)) {
          setError(
            "Could not connect to Pneumo or open local storage. Check your connection and browser storage permissions, then try again.",
          );
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!ready || error) return;
    if (!initialized) navigate("/setup");
    else if (!session) navigate("/login");
    else if (!["/", "/devices", "/settings"].includes(path)) navigate("/");
  }, [ready, error, initialized, session, path]);

  useEffect(() => {
    const titles: Record<string, string> = {
      "/setup": "Set up Pneumo",
      "/login": "Sign in",
      "/": "Home",
      "/devices": "Devices",
      "/settings": "Settings",
    };
    document.title = `${titles[path] ?? "Home"} · Pneumo`;
    if (ready) document.getElementById("main")?.focus({ preventScroll: true });
  }, [path, ready]);

  const signedIn = session !== null && device !== null;
  const routeReady = signedIn || path === (initialized ? "/login" : "/setup");
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-wordmark" aria-hidden="true" />
          <span className="sr-only">Pneumo home</span>
        </Link>
        {signedIn && (
          <nav aria-label="Main navigation">
            {(
              [
                ["/", "Home"],
                ["/devices", "Devices"],
                ["/settings", "Settings"],
              ] as const
            ).map(([href, label]) => (
              <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>
                {label}
              </Link>
            ))}
          </nav>
        )}
      </header>
      <main id="main" tabIndex={-1} className={signedIn ? "app-main" : "auth-main"}>
        {!ready || (!error && !routeReady) ? (
          <p role="status">Connecting to Pneumo…</p>
        ) : error ? (
          <section className="auth-surface">
            <h1>Connection unavailable</h1>
            <ErrorNotice>{error}</ErrorNotice>
            <button type="button" onClick={() => window.location.reload()}>
              Try again
            </button>
          </section>
        ) : !signedIn ? (
          <AuthView
            key={path}
            setup={!initialized}
            api={api}
            message={message}
            onSignedIn={(next, nextDevice) => {
              signingOut.current = false;
              setSession(next);
              setDevice(nextDevice);
              setInitialized(true);
              setMessage(null);
              navigate("/");
            }}
          />
        ) : path === "/settings" ? (
          <SettingsView
            api={api}
            device={currentDevice ?? device}
            onRename={(name) => home.renameDevice(session.deviceId, name)}
            onSigningOut={(pending) => {
              signingOut.current = pending;
            }}
            onSignedOut={signedOut}
          />
        ) : path === "/devices" ? (
          <DevicesView api={api} session={session} state={home} onRemoveSelf={removeSelf} />
        ) : (
          <HomeView state={home} />
        )}
      </main>
    </>
  );
}
