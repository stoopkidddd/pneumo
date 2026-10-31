import { b64uEncode, deriveKeys, deriveMasterKey, keyCheck, newKdfParams } from "@pneumo/crypto";
import type { DeviceDTO } from "@pneumo/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import { defaultDeviceName } from "../device-name.js";
import { type Session, save } from "../session/store.js";
import { DeviceNameField, ErrorNotice, PassphraseFields } from "./fields.js";
import { passphraseError } from "./passphrase.js";

type Props = {
  setup: boolean;
  api: ApiClient;
  message: string | null;
  onSignedIn: (session: Session, device: DeviceDTO) => void;
};

export function AuthView({ setup, api, message, onSignedIn }: Props) {
  const [setupToken] = useState(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("token"),
  );
  const [deviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ session: Session; device: DeviceDTO } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const missingToken = setup && !setupToken;

  useEffect(() => {
    if (setup && setupToken) window.history.replaceState(null, "", window.location.pathname);
  }, [setup, setupToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || missingToken) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    let passphrase = String(data.get("passphrase") ?? "");
    const name = String(data.get("deviceName") ?? "").trim();
    const validation = setup
      ? passphraseError(passphrase, String(data.get("repeated") ?? ""))
      : null;
    if (validation || !name) {
      setError(validation ?? "Enter a name for this device.");
      return;
    }
    setError(null);
    setBusy(true);
    let mk: Uint8Array<ArrayBuffer> | undefined;
    let authKey: Uint8Array<ArrayBuffer> | undefined;
    let retained = false;
    try {
      const kdf = setup ? newKdfParams() : (await api.request("authParams")).kdf;
      mk = await deriveMasterKey(passphrase, kdf);
      passphrase = "";
      const keys = await deriveKeys(mk);
      authKey = keys.authKey;
      const device = { name, platform: "web" as const };
      const response = setup
        ? await api.request("setup", {
            body: {
              setupToken: setupToken ?? "",
              kdf,
              authKey: b64uEncode(authKey),
              keyCheck: b64uEncode(await keyCheck(mk)),
              device,
            },
          })
        : await api.request("login", { body: { authKey: b64uEncode(authKey), device } });
      const session: Session = {
        deviceId: response.device.id,
        token: response.token,
        mk,
        contentKey: keys.contentKey,
      };
      form.reset();
      if (setup) {
        setPending({ session, device: response.device });
        retained = true;
      } else {
        await save(session);
        retained = true;
        onSignedIn(session, response.device);
      }
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.status === 401
            ? "Wrong passphrase"
            : failure.status === 429
              ? `Too many attempts. Try again in ${Math.max(1, Math.ceil((failure.retryAfterSeconds ?? 900) / 60))} minutes`
              : failure.status === 403 && setup
                ? "This setup token is not valid. Open the setup link provided by your server."
                : failure.status === 409 && setup
                  ? "This instance is already set up. Open Sign in to continue."
                  : failure.message
          : "Could not sign in. Check your connection and make sure this browser allows local storage, then try again.",
      );
    } finally {
      passphrase = "";
      authKey?.fill(0);
      if (!retained) mk?.fill(0);
      setBusy(false);
    }
  }

  async function finishSetup() {
    if (!pending || !acknowledged || busy) return;
    setBusy(true);
    setError(null);
    try {
      await save(pending.session);
      onSignedIn(pending.session, pending.device);
    } catch {
      setError("Could not save your session. Allow local storage in this browser, then try again.");
    } finally {
      setBusy(false);
    }
  }

  if (pending)
    return (
      <section className="auth-surface" aria-labelledby="auth-title">
        <h1 id="auth-title">Keep your passphrase safe</h1>
        <p>If you forget this passphrase, your history can't be recovered.</p>
        <p className="muted">
          Save it somewhere safe, such as your password manager. Pneumo has no passphrase reset.
        </p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>I understand that my history cannot be recovered without my passphrase</span>
        </label>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <button
          className="primary"
          type="button"
          disabled={!acknowledged || busy}
          onClick={() => void finishSetup()}
        >
          Continue to Home
        </button>
      </section>
    );

  return (
    <section className="auth-surface" aria-labelledby="auth-title">
      <h1 id="auth-title">{setup ? "Set up Pneumo" : "Sign in"}</h1>
      <p className="intro">
        {setup
          ? "One passphrase for your private dispatch. It encrypts your notes, links, and files before they leave your devices."
          : "Enter your passphrase to connect this browser to your Pneumo instance."}
      </p>
      {missingToken ? (
        <ErrorNotice>
          Setup token is missing. Open the full setup link from your server, including the #token=
          fragment.
        </ErrorNotice>
      ) : (
        <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
          <fieldset disabled={busy}>
            <PassphraseFields setup={setup} />
            <DeviceNameField defaultValue={deviceName} />
          </fieldset>
          {error ? (
            <ErrorNotice>{error}</ErrorNotice>
          ) : (
            message && (
              <p className="notice" role="status">
                {message}
              </p>
            )
          )}
          <button className="primary" type="submit" disabled={busy}>
            {setup ? "Create instance" : "Sign in"}
          </button>
          {busy && (
            <p role="status" className="field-help busy">
              Deriving your encryption keys. This can take a moment…
            </p>
          )}
        </form>
      )}
      <p className="privacy-note">
        Your passphrase stays in this browser. Only derived authentication material is sent to the
        server.
      </p>
      {setup && !missingToken && <a href="/login">Already set up? Sign in</a>}
    </section>
  );
}
