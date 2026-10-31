import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import { ErrorNotice } from "../views/fields.js";

export function DeviceNameForm({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (name: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(name), [name]);
  const inline = onCancel !== undefined;
  useEffect(() => {
    if (inline) input.current?.focus();
  }, [inline]);

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(draft.trim());
      setSaved(true);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 401)) {
        setError("Could not rename this device. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label htmlFor={id}>Device name</label>
        <input
          ref={input}
          id={id}
          value={draft}
          disabled={busy}
          required
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="device-actions">
        <button type="submit" disabled={busy || !draft.trim() || draft.trim() === name}>
          Save name
        </button>
        {onCancel && (
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {busy && <p role="status">Saving name…</p>}
      {saved && <p role="status">Device name saved.</p>}
    </form>
  );
}
