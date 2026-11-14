import { useCallback, useEffect, useState } from "react";
import { getDesktop, isDesktop } from "../../services/emulator/contract";
import type {
  TransferDirection,
  TransferFile,
  TransferPeer,
  TransferSession,
  TransferStatus,
} from "../../services/transfer/contract";

/**
 * Desktop-side bidirectional phone <-> PC transfer UI.
 *
 * Wires into the Electron transfer service exposed through window.aemDesktop
 * (preload `transfer.*` handlers -> ipcMain -> TransferService). Runs entirely
 * on the local LAN; no cloud account, no Supabase row, no internet in the file
 * path. Real device-to-device discovery/transfer requires physical devices on
 * the same network — not executable in this sandbox; verified at typecheck +
 * build level only.
 */
export default function DesktopTransfer() {
  const desktop = getDesktop();
  const bridge = desktop?.transfer;
  const available = isDesktop() && !!desktop;

  const [mode, setMode] = useState<TransferDirection | null>(null);
  const [peers, setPeers] = useState<TransferPeer[]>([]);
  const [sessions, setSessions] = useState<TransferSession[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!bridge) return;
    const unsub = bridge.onSessionChange((s: TransferSession) => {
      setSessions((cur) => {
        const next = [...cur];
        const i = next.findIndex((x) => x.id === s.id);
        if (i === -1) next.push(s);
        else next[i] = s;
        return next;
      });
    });
    return () => unsub();
  }, [bridge]);

  const refreshSessions = useCallback(async () => {
    if (!bridge) return;
    try {
      setSessions(await bridge.listSessions());
    } catch {
      // ignore
    }
  }, [bridge]);

  const scan = useCallback(async () => {
    if (!bridge) return;
    setDiscovering(true);
    try {
      const found = await bridge.discover({ timeoutMs: 8000 });
      setPeers(found);
      setStatus(found.length
        ? `${found.length} device(s) discovered`
        : "No devices discovered — make sure the phone is in Receive mode");
    } catch (e: any) {
      setStatus(`Discovery failed: ${e.message || "unknown"}`);
    } finally {
      setDiscovering(false);
    }
  }, [bridge]);

  const startReceiving = useCallback(async () => {
    if (!bridge) return;
    try {
      await bridge.startReceiving({ allowIncoming: true, downloadDir: undefined });
      setReceiving(true);
      setMode("receive");
      setStatus("Receiving — advertise this PC to your phone; tap Send on the phone.");
    } catch (e: any) {
      setStatus(`Start receiving failed: ${e.message || "unknown"}`);
    }
  }, [bridge]);

  const stopReceiving = useCallback(async () => {
    if (!bridge) return;
    try {
      await bridge.stop();
      setReceiving(false);
      setStatus("Stopped receiving.");
    } catch {
      // ignore
    }
  }, [bridge]);

  const sendToPeer = useCallback(
    (peer: TransferPeer) => {
      if (!desktop) return;
      void desktop.pickFile
        ?.({
          title: "Select files to send to phone",
          filters: [{ name: "All Files", extensions: ["*"] }],
        })
        .then(async (r) => {
          if (r.canceled || !r.filePaths.length) return;
          setMode("send");
          try {
            await bridge!.send({ peerId: peer.id, filePaths: r.filePaths });
            setStatus(`Sending ${r.filePaths.length} file(s) to ${peer.name}…`);
            await refreshSessions();
          } catch (e: any) {
            setStatus(`Send failed: ${e.message || "unknown"}`);
          }
        });
    },
    [desktop, bridge, refreshSessions],
  );

  const cancelSession = useCallback(
    (id: string) => {
      void bridge?.cancel(id).then(refreshSessions);
    },
    [bridge, refreshSessions],
  );
  const pauseSession = useCallback(
    (id: string) => {
      void bridge?.pause(id).then(refreshSessions);
    },
    [bridge, refreshSessions],
  );
  const resumeSession = useCallback(
    (id: string) => {
      void bridge?.resume(id).then(refreshSessions);
    },
    [bridge, refreshSessions],
  );

  const statusColor = (s: TransferStatus) => {
    switch (s) {
      case "completed": return "#2e7d32";
      case "failed": return "#c62828";
      case "cancelled": return "#616161";
      case "paused": return "#f9a825";
      case "transferring": return "#1565c0";
      case "paired": return "#7b1fa2";
      default: return "#546e7a";
    }
  };

  const pct = (f: TransferFile) =>
    f.size > 0 ? Math.round((f.transferred / f.size) * 100) : 0;

  return (
    <section className="content transfer-page desktop-transfer">
      <div className="section-head">
        <div>
          <span>TRANSFER</span>
          <h2>Phone ↔ PC transfer</h2>
        </div>
        <span className="transfer-pill">{available ? "Desktop" : "Unavailable"}</span>
      </div>

      {!available && (
        <div className="transfer-note">
          <div>
            <strong>Desktop transfer requires the Windows desktop build.</strong>
            <p>
              Install AEM Store for Windows (Setup EXE or Portable EXE from GitHub
              Releases) to discover phones on the LAN and send/receive files
              directly, without the emulator and without the cloud.
            </p>
          </div>
        </div>
      )}

      {available && (
        <>
          <div className="transfer-modes" style={{ marginBottom: 12 }}>
            <button
              className={mode === "send" ? "install active-choice" : "choice"}
              onClick={() => setMode("send")}
              disabled={discovering}
            >
              {discovering ? "Scanning…" : "Send files to phone"}
            </button>
            <button
              className={receiving ? "install active-choice" : "choice"}
              onClick={receiving ? stopReceiving : startReceiving}
              disabled={discovering}
            >
              {receiving ? "Stop receiving" : "Receive files from phone"}
            </button>
          </div>

          {mode === "send" && (
            <div className="setting" style={{ marginBottom: 12 }}>
              <button className="setting-head" onClick={scan}>
                <strong>Discover phones on the LAN</strong>
                <span>{discovering ? "⟳" : "+"}</span>
              </button>
              {discovering && <p>Scanning for devices in Receive mode…</p>}
              {!discovering && peers.length === 0 && (
                <p>No phones discovered. Have the other phone tap "Start receiving" and scan again.</p>
              )}
              <div className="choice-row" style={{ marginTop: 8 }}>
                {peers.map((p) => (
                  <button
                    key={p.id}
                    className="choice"
                    onClick={() => sendToPeer(p)}
                  >
                    Send to {p.name} ({p.platform})
                  </button>
                ))}
              </div>
            </div>
          )}

          {mode === "receive" && (
            <div className="setting" style={{ marginBottom: 12 }}>
              <p>
                {receiving
                  ? "This PC is advertising as a receive target. Send files from your phone."
                  : "Tap Start receiving, then send files from your phone to this PC."}
              </p>
            </div>
          )}

          <div className="setting">
            <button className="setting-head" onClick={refreshSessions}>
              <strong>Transfer sessions</strong>
              <span>⟳</span>
            </button>
            <div className="setting-body">
              {sessions.length === 0 ? (
                <p>No transfer sessions yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {sessions.map((s) => (
                    <article key={s.id} className="card compact">
                      <div className="card-main">
                        <div className="meta">
                          {s.direction === "send" ? "→ " : "← "}{s.peer.name}
                          &nbsp;·&nbsp;
                          <span style={{ color: statusColor(s.status), fontWeight: 600 }}>
                            {s.status}
                          </span>
                        </div>
                        <h4>{s.files.length} file(s) · {formatBytes(s.totalBytes)}</h4>
                        {s.files.map((f) => (
                          <div key={f.id} style={{ marginTop: 6, fontSize: "0.85rem", opacity: 0.9 }}>
                            {f.name} &nbsp;({pct(f)}%)&nbsp;
                            <div
                              className="progress-track"
                              style={{ marginTop: 4, height: 6, background: "#374151", borderRadius: 3, overflow: "hidden" }}
                            >
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${pct(f)}%`,
                                  height: "100%",
                                  background: statusColor(s.status),
                                  borderRadius: 3,
                                }}
                              />
                            </div>
                            <small>{formatBytes(f.transferred)} / {formatBytes(f.size)}</small>
                            {f.sha256 && <small style={{ marginLeft: 6 }}>{f.sha256.slice(0, 12)}…</small>}
                          </div>
                        ))}
                        {s.error && <p style={{ color: "#c62828", marginTop: 6 }}>{s.error}</p>}
                      </div>
                      <div className="card-actions" style={{ display: "flex", gap: 6 }}>
                        {s.status === "transferring" && (
                          <button className="choice" onClick={() => pauseSession(s.id)}>Pause</button>
                        )}
                        {s.status === "paused" && (
                          <button className="choice" onClick={() => resumeSession(s.id)}>Resume</button>
                        )}
                        {(s.status === "transferring" || s.status === "paused" || s.status === "paired") && (
                          <button className="choice" onClick={() => cancelSession(s.id)}>Cancel</button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="transfer-note">
            <div>
              <strong>How it works</strong>
              <ul style={{ marginTop: 6, paddingLeft: 20 }}>
                <li>Discovery uses a local UDP beacon on the LAN (no internet).</li>
                <li>Files stream over a local TCP channel with SHA-256 verification.</li>
                <li>Interrupted transfers resume from the last verified offset.</li>
                <li>Nothing is stored in Supabase and nothing leaves your LAN.</li>
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}
