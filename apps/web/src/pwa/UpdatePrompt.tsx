import { useRegisterSW } from "virtual:pwa-register/react";
import { useState } from "react";
import "./pwa.css";

export function UpdatePrompt() {
  const [error, setError] = useState(false);
  const {
    needRefresh: [waiting],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  if (!waiting) return null;
  return (
    <aside className="update-toast" aria-label="App update">
      <p role="status">A new version of Pneumo is ready.</p>
      <button
        type="button"
        onClick={() => {
          setError(false);
          void updateServiceWorker(true).catch(() => setError(true));
        }}
      >
        Reload to update
      </button>
      {error && <p role="alert">Could not update. Check your connection and try again.</p>}
    </aside>
  );
}
