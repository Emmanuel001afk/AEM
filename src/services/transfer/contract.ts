/**
 * Bidirectional phone <-> PC transfer contract (desktop side).
 * Mirrors the Android-side AEM Transfer protocol (protocol v6, DNS-SD discovery,
 * SHA-256 integrity, offset-based resume). The desktop service runs locally;
 * no cloud account and no Supabase storage is involved in the file path.
 */
export type TransferDirection = "send" | "receive";
export type TransferStatus =
  | "idle"
  | "discovering"
  | "paired"
  | "transferring"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

export interface TransferPeer {
  id: string;
  name: string;
  platform: "android" | "windows" | "unknown";
  version?: string;
  lastSeenAt: string;
}

export interface TransferFile {
  id: string;
  name: string;
  size: number;
  sha256: string;            // expected SHA-256 of the whole file
  transferred: number;       // bytes already transferred (resume offset)
  completed: boolean;
}

export interface TransferSession {
  id: string;
  direction: TransferDirection;
  status: TransferStatus;
  peer: TransferPeer;
  files: TransferFile[];
  totalBytes: number;
  transferredBytes: number;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface TransferDiscoveryOptions {
  timeoutMs?: number;
}

export interface TransferSendOptions {
  peerId: string;
  filePaths: string[];
}

export interface TransferReceiveOptions {
  allowIncoming: boolean;
  downloadDir?: string;
}

export interface TransferProgressEvent {
  sessionId: string;
  fileId: string;
  transferred: number;
  total: number;
  percent: number;
}

export interface TransferBridge {
  /** Start local discovery (UDP beacon + listener). Returns discovered peers. */
  discover(opts?: TransferDiscoveryOptions): Promise<TransferPeer[]>;
  /** Start advertising this PC as a receive target. */
  startReceiving(opts?: TransferReceiveOptions): Promise<void>;
  /** Stop advertising / discovery. */
  stop(): Promise<void>;
  /** Send files to a discovered peer. */
  send(opts: TransferSendOptions): Promise<TransferSession>;
  /** List all sessions (in-flight + history). */
  listSessions(): Promise<TransferSession[]>;
  /** Cancel a session. */
  cancel(sessionId: string): Promise<void>;
  /** Pause / resume a session. */
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** Subscribe to progress events for a session. */
  onProgress(
    sessionId: string,
    cb: (e: TransferProgressEvent) => void,
  ): () => void;
  /** Subscribe to session state changes. */
  onSessionChange(cb: (s: TransferSession) => void): () => void;
}
