/**
 * Phone-powered desktop: IPC/contract scaffolding (renderer side).
 *
 * Mirrors the Electron-side phone session handlers. Gated behind explicit user
 * authorization; no mirroring/control runtime is implemented here — it requires
 * physical devices + ADB and is not executable in this sandbox.
 */
import type { PhoneDevice, PhoneSession } from "../../domain/phonePowered";

export interface PhoneBridge {
  /** Discover ADB-reachable phones on USB/LAN. Requires authorization. */
  discoverPhones(): Promise<PhoneDevice[]>;
  /** Authorize a discovered phone for desktop control (pairing). */
  authorizePhone(serial: string): Promise<boolean>;
  /** Start a mirroring + control session with an authorized phone. */
  startSession(serial: string): Promise<PhoneSession>;
  /** End the active session. */
  endSession(sessionId: string): Promise<void>;
  /** Subscribe to session state changes. */
  onSessionChange(cb: (s: PhoneSession) => void): () => void;
  /** Whether the host currently has an authorized, mirroring session. */
  hasActiveSession(): Promise<boolean>;
}
