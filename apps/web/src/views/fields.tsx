import { useState } from "react";

export function ErrorNotice({ children }: { children: string }) {
  return (
    <p className="notice error" role="alert">
      <svg aria-hidden="true" viewBox="0 0 20 20" className="status-icon">
        <circle cx="10" cy="10" r="8" />
        <path d="M10 5v6m0 3v1" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

export function PassphraseFields({ setup }: { setup: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <div className="field">
        <label htmlFor="passphrase">Passphrase</label>
        <input
          id="passphrase"
          name="passphrase"
          type={visible ? "text" : "password"}
          autoComplete={setup ? "new-password" : "current-password"}
          aria-describedby={setup ? "passphrase-help" : undefined}
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        {setup && (
          <p id="passphrase-help" className="field-help">
            At least 12 characters. A few memorable words work well.
          </p>
        )}
      </div>
      {setup && (
        <div className="field">
          <label htmlFor="repeat-passphrase">Repeat passphrase</label>
          <input
            id="repeat-passphrase"
            name="repeated"
            type={visible ? "text" : "password"}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </div>
      )}
      <button
        className="text-button"
        type="button"
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
      >
        {visible ? "Hide passphrase" : "Show passphrase"}
      </button>
    </>
  );
}

export function DeviceNameField({ defaultValue }: { defaultValue: string }) {
  return (
    <div className="field device-field">
      <label htmlFor="device-name">Device name</label>
      <input
        id="device-name"
        name="deviceName"
        autoComplete="off"
        defaultValue={defaultValue}
        required
      />
      <p className="field-help">How this browser appears on your devices.</p>
    </div>
  );
}
