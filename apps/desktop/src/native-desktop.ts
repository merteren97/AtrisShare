import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface NativeDesktopSettings {
  native: boolean;
  closeToTray: boolean;
  trayAvailable: boolean;
  settingsError: boolean;
}
export type NativeNotificationPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale" | "unavailable";
export type DueNotificationStatus = "submitted" | "duplicate" | "permission-required" | "capacity" | "unavailable" | "failed";
export interface DueNotificationInput {
  /** Stable account/destination/occurrence identity; never a credential or approval. Max 256 ASCII ID characters. */
  id: string;
  /** Generic reminder text only. Do not include private media, account names or credentials in OS notifications. */
  title?: string;
  body?: string;
}
export interface DueNotificationResult { status: DueNotificationStatus }

export async function getNativeDesktopSettings(): Promise<NativeDesktopSettings> {
  if (!isTauri()) return { native: false, closeToTray: false, trayAvailable: false, settingsError: false };
  const settings = await invoke<Omit<NativeDesktopSettings, "native">>("native_desktop_settings");
  return { ...settings, native: true };
}
export async function setCloseToTray(enabled: boolean): Promise<NativeDesktopSettings> {
  if (!isTauri()) throw new Error("native_unavailable");
  const settings = await invoke<Omit<NativeDesktopSettings, "native">>("native_set_close_to_tray", { enabled });
  return { ...settings, native: true };
}
export async function getNotificationPermission(): Promise<NativeNotificationPermission> {
  return isTauri() ? invoke<NativeNotificationPermission>("native_notification_permission") : "unavailable";
}
export async function requestNotificationPermission(): Promise<NativeNotificationPermission> {
  return isTauri() ? invoke<NativeNotificationPermission>("native_request_notification_permission") : "unavailable";
}

const pending = new Map<string, Promise<DueNotificationResult>>();
/**
 * Optional reminder only: never requests permission implicitly, approves or publishes.
 * Native dedup covers webview reloads/concurrent calls for the same occurrence ID in
 * this process session. Accepted IDs are not evicted (4096 maximum). Failed sends
 * remain retryable; "submitted" means plugin acceptance, never confirmed OS delivery.
 * Cross-restart reminder policy belongs to the durable scheduler/inbox.
 */
export async function notifyDue(input: DueNotificationInput): Promise<DueNotificationResult> {
  if (!isTauri()) return { status: "unavailable" };
  const existing = pending.get(input.id);
  if (existing) return existing;
  const operation = invoke<DueNotificationStatus>("native_notify_due", { input: {
    id: input.id, title: input.title ?? "AtrisShare",
    body: input.body ?? "An item is waiting in the review inbox. Open AtrisShare to review it."
  } }).then(status => ({ status })).catch(() => ({ status: "failed" as const }));
  pending.set(input.id, operation);
  try { return await operation; }
  finally { pending.delete(input.id); }
}

/** Tray Show / supported notification taps restore the window and request inbox navigation only. */
export async function onNativeOpenQueue(handler: () => void): Promise<UnlistenFn> {
  return isTauri() ? listen("atris-share://open-queue", handler) : () => {};
}
