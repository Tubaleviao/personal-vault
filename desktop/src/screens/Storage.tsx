import React, { useState, useEffect, useCallback } from 'react'
import type { Vault } from '@vault/vault'
import {
  getStoragePath, setStoragePath, readStorageVault, getLastSyncError, compareCopies,
  readVaultFile, writeVaultFile, StorageError, STORAGE_MESSAGES,
} from '../tauriVault'

interface Props {
  vault: Vault
}

type Status = { ok: boolean; msg: string } | null

function describe(err: unknown): string {
  return err instanceof StorageError ? err.message : err instanceof Error ? err.message : String(err)
}

export default function Storage({ vault }: Props) {
  const [saved, setSaved] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const p = await getStoragePath().catch(() => null)
    setSaved(p)
    setInput(p ?? '')
    setSyncError(getLastSyncError()?.message ?? null)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleSave = async () => {
    setBusy(true)
    setStatus(null)
    try {
      await setStoragePath(input.trim() || null)
      await refresh()
      setStatus({ ok: true, msg: input.trim() ? 'Storage location saved.' : 'Storage sync disabled.' })
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  const handleTestRead = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const remote = await readStorageVault(input.trim() || null)
      const local = await readVaultFile()
      const newer = compareCopies(local, remote)
      const msg = newer === 'same'
        ? `Storage copy is up to date (sequence ${remote.header.sequenceNumber ?? 0}).`
        : newer === 'remote'
          ? `Storage copy is newer (sequence ${remote.header.sequenceNumber ?? 0} vs local ${local?.header.sequenceNumber ?? 0}). It will be used next time you unlock.`
          : `Local copy is newer (sequence ${local?.header.sequenceNumber ?? 0} vs storage ${remote.header.sequenceNumber ?? 0}). It will be written to storage on the next save.`
      setStatus({ ok: true, msg })
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  // "Use local copy": overwrite storage with the local file now.
  const handleUseLocal = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const local = await readVaultFile()
      if (!local) throw new Error('No local vault file.')
      await writeVaultFile(local)
      await refresh()
      const err = getLastSyncError()
      setStatus(err ? { ok: false, msg: err.message } : { ok: true, msg: 'Storage updated from local copy.' })
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2 style={styles.heading}>Storage</h2>
      <p style={styles.hint}>
        Keep an encrypted copy of this vault in a folder synced by iCloud Drive, Dropbox, Google Drive,
        or on a flash drive. The file is always encrypted; the provider never sees your data.
        Enter the full path to the vault file, e.g. <code>/home/you/Dropbox/vault.json</code>.
      </p>

      <label style={styles.label}>Vault file path</label>
      <input
        style={styles.input}
        value={input}
        placeholder={STORAGE_MESSAGES.NOT_CONFIGURED}
        onChange={e => setInput(e.target.value)}
        spellCheck={false}
      />
      <div style={styles.row}>
        <button style={styles.btn} disabled={busy} onClick={() => { void handleSave() }}>Save</button>
        <button style={styles.btn} disabled={busy || !input.trim()} onClick={() => { void handleTestRead() }}>
          Test read
        </button>
        <button style={styles.btn} disabled={busy || !saved} onClick={() => { void handleUseLocal() }}>
          Use local copy
        </button>
      </div>

      {status && (
        <div style={status.ok ? styles.ok : styles.err}>{status.msg}</div>
      )}
      {syncError && <div style={styles.err}>Last sync failed: {syncError}</div>}
      <div style={styles.meta}>
        Vault {vault.owner.did.slice(0, 20)}… · {saved ? `syncing to ${saved}` : 'sync disabled'}
      </div>
    </div>
  )
}

const styles = {
  heading: { fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 12 } as React.CSSProperties,
  hint: { color: '#94a3b8', fontSize: 13, lineHeight: 1.5, marginBottom: 20, maxWidth: 560 } as React.CSSProperties,
  label: { display: 'block', color: '#94a3b8', fontSize: 12, marginBottom: 6 } as React.CSSProperties,
  input: {
    width: '100%', maxWidth: 560, background: '#0f172a', border: '1px solid #334155',
    borderRadius: 6, color: '#f1f5f9', fontSize: 13, padding: '8px 10px', boxSizing: 'border-box',
  } as React.CSSProperties,
  row: { display: 'flex', gap: 8, marginTop: 12 } as React.CSSProperties,
  btn: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9',
    cursor: 'pointer', fontSize: 12, padding: '7px 12px',
  } as React.CSSProperties,
  ok: { color: '#22c55e', fontSize: 13, marginTop: 14, maxWidth: 560 } as React.CSSProperties,
  err: { color: '#f87171', fontSize: 13, marginTop: 14, maxWidth: 560 } as React.CSSProperties,
  meta: { color: '#475569', fontSize: 11, marginTop: 24 } as React.CSSProperties,
} as const
