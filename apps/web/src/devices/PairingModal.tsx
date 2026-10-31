import { buildPairingUri } from "@pneumo/crypto";
import type { DeviceDTO } from "@pneumo/protocol";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { Session } from "../session/store.js";
import "./pairing.css";

const PAIR_LIFETIME_MS = 10 * 60 * 1_000;

type PairingState =
  | { phase: "loading"; generation: number }
  | {
      phase: "ready";
      generation: number;
      expiresAt: number;
      createdAt: number;
      remainingSeconds: number;
      baselineDeviceId: string | null;
    }
  | { phase: "expired"; generation: number }
  | { phase: "error"; generation: number };

type PairingModalProps = {
  api: ApiClient;
  session: Session;
  addedDevice: DeviceDTO | null;
  onClose: () => void;
  onPaired: (device: DeviceDTO) => void;
};

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
}

function remainingSeconds(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PairingModal({ api, session, addedDevice, onClose, onPaired }: PairingModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const pairedRef = useRef(false);
  const latestAddedDeviceRef = useRef(addedDevice);
  latestAddedDeviceRef.current = addedDevice;

  const [pairing, setPairing] = useState<PairingState>({ phase: "loading", generation: 0 });

  const makeCode = useCallback(async () => {
    const generation = ++generationRef.current;
    const baselineDeviceId = latestAddedDeviceRef.current?.id ?? null;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    clearCanvas(canvasRef.current);
    setPairing({ phase: "loading", generation });

    try {
      const response = await api.request("createPair", { signal: controller.signal });
      if (!mountedRef.current || generation !== generationRef.current) return;

      const expiresAt = Date.parse(response.expiresAt);
      if (!Number.isFinite(expiresAt)) throw new TypeError("Invalid pairing expiry");
      if (remainingSeconds(expiresAt) === 0) {
        setPairing({ phase: "expired", generation });
        return;
      }

      const scratchCanvas = document.createElement("canvas");
      const pairingUri = buildPairingUri({
        origin: window.location.origin,
        code: response.code,
        mk: session.mk,
      });
      await QRCode.toCanvas(scratchCanvas, pairingUri, {
        errorCorrectionLevel: "M",
        margin: 4,
        scale: 6,
        color: { dark: "#151922", light: "#ffffff" },
      });
      if (!mountedRef.current || generation !== generationRef.current) return;

      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) throw new Error("Canvas is unavailable");
      canvas.width = scratchCanvas.width;
      canvas.height = scratchCanvas.height;
      context.drawImage(scratchCanvas, 0, 0);

      setPairing({
        phase: "ready",
        generation,
        expiresAt,
        createdAt: expiresAt - PAIR_LIFETIME_MS,
        remainingSeconds: remainingSeconds(expiresAt),
        baselineDeviceId,
      });
    } catch (failure) {
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        (failure instanceof DOMException && failure.name === "AbortError")
      ) {
        return;
      }
      clearCanvas(canvasRef.current);
      setPairing({ phase: "error", generation });
    }
  }, [api, session.mk]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void makeCode();
    return () => {
      mountedRef.current = false;
      ++generationRef.current;
      abortRef.current?.abort();
      clearCanvas(canvasRef.current);
    };
  }, [makeCode]);

  const countdownExpiresAt = pairing.phase === "ready" ? pairing.expiresAt : null;

  useEffect(() => {
    if (countdownExpiresAt === null) return;
    const generation = pairing.generation;
    const updateCountdown = () => {
      const nextRemaining = remainingSeconds(countdownExpiresAt);
      if (nextRemaining === 0) {
        clearCanvas(canvasRef.current);
        setPairing((current) =>
          current.phase === "ready" && current.generation === generation
            ? { phase: "expired", generation }
            : current,
        );
        return;
      }
      setPairing((current) =>
        current.phase === "ready" &&
        current.generation === generation &&
        current.remainingSeconds !== nextRemaining
          ? { ...current, remainingSeconds: nextRemaining }
          : current,
      );
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1_000);
    return () => window.clearInterval(interval);
  }, [countdownExpiresAt, pairing.generation]);

  useEffect(() => {
    if (pairing.phase !== "ready" || !addedDevice || pairedRef.current) return;
    if (addedDevice.id === pairing.baselineDeviceId) return;
    const deviceCreatedAt = Date.parse(addedDevice.createdAt);
    if (!Number.isFinite(deviceCreatedAt) || deviceCreatedAt <= pairing.createdAt) return;

    pairedRef.current = true;
    onPaired(addedDevice);
  }, [addedDevice, onPaired, pairing]);

  const loading = pairing.phase === "loading";

  return (
    <dialog
      ref={dialogRef}
      className="pairing-dialog"
      aria-labelledby="pairing-title"
      aria-describedby="pairing-instruction"
      onClose={onClose}
    >
      <div className="pairing-header">
        <h2 id="pairing-title">Add a phone</h2>
        <form method="dialog">
          <button type="submit" className="text-button pairing-close">
            Close
          </button>
        </form>
      </div>

      <div className="pairing-content" aria-busy={loading}>
        <p id="pairing-instruction" className="pairing-instruction">
          Open Pneumo on your phone and tap Scan
        </p>

        <div className="pairing-qr-frame" hidden={pairing.phase !== "ready"}>
          <canvas ref={canvasRef} role="img" aria-label="Pairing QR code" />
        </div>

        {pairing.phase === "loading" && (
          <p className="pairing-state muted" role="status">
            Making a secure pairing code…
          </p>
        )}
        {pairing.phase === "ready" && (
          <p className="pairing-countdown" role="timer" aria-live="off">
            Code expires in {formatCountdown(pairing.remainingSeconds)}
          </p>
        )}
        {pairing.phase === "expired" && (
          <p className="pairing-state error" role="alert">
            This code has expired. Make a new code to continue.
          </p>
        )}
        {pairing.phase === "error" && (
          <p className="pairing-state error" role="alert">
            Could not make a pairing code. Check your connection and try again.
          </p>
        )}

        <div className="pairing-actions">
          <button type="button" disabled={loading} onClick={() => void makeCode()}>
            New code
          </button>
        </div>
      </div>
    </dialog>
  );
}
