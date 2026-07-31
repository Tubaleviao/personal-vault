/**
 * Native messaging bridge — vault file I/O via the desktop app.
 *
 * When the Personal Vault desktop app is installed and the native host is
 * registered (see native-host/install.sh), the extension routes vault reads
 * and writes through it instead of chrome.storage.local.  This makes the
 * desktop app the single source of truth for the vault file, so the two UIs
 * always see the same data without needing the relay.
 *
 * The native host is probed once per service-worker lifetime.  If the connect
 * attempt fails (host not installed, binary not found) we fall back silently to
 * chrome.storage.local and the extension works exactly as before.
 *
 * Protocol: each call opens a short-lived port, sends one message, waits for
 * one response, then disconnects.  Chrome native messaging does not support
 * persistent connections across service-worker restarts, so we re-connect on
 * each call rather than caching the port.
 */

import type { NativeRequest, NativeResponse } from './messages'

const HOST_NAME = 'com.personal_vault'

/** Send one request to the native host and return the response. */
function sendNative(request: NativeRequest): Promise<NativeResponse> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port

    try {
      port = chrome.runtime.connectNative(HOST_NAME)
    } catch (err) {
      reject(err)
      return
    }

    const onMessage = (response: NativeResponse) => {
      cleanup()
      resolve(response)
    }

    const onDisconnect = () => {
      cleanup()
      const err = chrome.runtime.lastError?.message ?? 'Native host disconnected'
      reject(new Error(err))
    }

    function cleanup() {
      port.onMessage.removeListener(onMessage)
      port.onDisconnect.removeListener(onDisconnect)
      try { port.disconnect() } catch { /* already gone */ }
    }

    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(onDisconnect)
    port.postMessage(request)
  })
}

/** Returns true if the desktop native host is reachable. */
export async function isNativeHostAvailable(): Promise<boolean> {
  try {
    const res = await sendNative({ type: 'VAULT_EXISTS' })
    return res.ok
  } catch {
    return false
  }
}

import type { PersistedVault } from '../src/vault'

/**
 * Read the vault blob from the desktop app.
 * Returns null if no vault file exists yet.
 * Throws if the host returned an error.
 */
export async function nativeReadVault(name?: string): Promise<PersistedVault | null> {
  const res = await sendNative({ type: 'READ_VAULT', name })
  if (!res.ok) throw new Error(res.error)
  if (!res.blob) return null
  return JSON.parse(res.blob) as PersistedVault
}

/**
 * Write the sealed vault blob to the desktop app's file storage.
 * Throws if the host returned an error.
 */
export async function nativeWriteVault(vault: PersistedVault): Promise<void> {
  const blob = JSON.stringify(vault)
  const res = await sendNative({ type: 'WRITE_VAULT', blob })
  if (!res.ok) throw new Error(res.error)
}

/**
 * List all vault files in the desktop vault directory.
 * Returns an array of { name, vault } for each valid vault file found.
 */
export async function nativeListVaults(): Promise<Array<{ name: string; vault: PersistedVault }>> {
  const res = await sendNative({ type: 'LIST_VAULTS' })
  if (!res.ok) throw new Error(res.error)
  const results: Array<{ name: string; vault: PersistedVault }> = []
  for (const entry of res.vaults ?? []) {
    try {
      const parsed = JSON.parse(entry.content) as PersistedVault
      if (parsed?.header?.version && parsed?.encrypted) {
        results.push({ name: entry.name, vault: parsed })
      }
    } catch { /* skip invalid JSON */ }
  }
  return results
}
