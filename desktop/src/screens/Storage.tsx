import React, { useState, useEffect, useCallback } from 'react'
import { Vault as VaultClass } from '@vault/vault'
import { mergeVaultsWithSummary as mergeCopies } from '@vault/merge'
import type { Vault, PersistedVault, MergeSummary } from '@vault/vault'
import {
  getStoragePath, setStoragePath, getSyncBase, readStorageVault, getLastSyncError, compareCopies,
  readVaultFile, writeLocalVaultFile, adoptStorageCopy, forceMirrorToStorage, StorageError, STORAGE_MESSAGES,
} from '../tauriVault'

interface Props {
  vault: Vault
  /** Called with the freshly opened vault after a merge / keep-external replaced the working copy. */
  onVaultReplaced: (vault: Vault, persisted: PersistedVault) => void
}

interface Divergence {
  local: PersistedVault
  remote: PersistedVault
}

interface MergePreview {
  merged: PersistedVault
  summary: MergeSummary
}

type Status = { ok: boolean; msg: string } | null

function describe(err: unknown): string {
  return err instanceof StorageError ? err.message : err instanceof Error ? err.message : String(err)
}

export default function Storage({ vault, onVaultReplaced }: Props) {
  const [saved, setSaved] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [divergence, setDivergence] = useState<Divergence | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [preview, setPreview] = useState<MergePreview | null>(null)

  const refresh = useCallback(async () => {
    let cfgError: string | null = null
    const p = await getStoragePath().catch((err: unknown) => { cfgError = describe(err); return null })
    setSaved(p)
    setInput(p ?? '')
    setSyncError(cfgError ?? getLastSyncError()?.message ?? null)
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
      const remote = await readStorageVault(saved)
      const local = await readVaultFile()
      const newer = compareCopies(local, remote, getSyncBase())
      if (local && local.header.ownerId !== remote.header.ownerId) throw new StorageError('OWNER_MISMATCH')
      if (local && newer === 'conflict') { setDivergence({ local, remote }); setPreview(null) } else setDivergence(null)
      const msg = newer === 'same'
        ? `Storage copy is up to date (sequence ${remote.header.sequenceNumber ?? 0}).`
        : newer === 'conflict'
          ? 'Storage copy and local copy have diverged (both have changes the other lacks). Neither will be overwritten automatically. Resolve it below.'
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
      // Overwriting is destructive: confirm unless storage is empty, older, or already identical.
      // Only a missing file may be overwritten without asking; an unreadable or
      // foreign file needs explicit confirmation.
      let remote: Awaited<ReturnType<typeof readStorageVault>> | null = null
      try {
        remote = await readStorageVault()
      } catch (err) {
        if (!(err instanceof StorageError && err.code === 'NOT_FOUND')) {
          const detail = err instanceof StorageError ? err.message : describe(err)
          if (!window.confirm(`The file at the storage path could not be verified as a vault (${detail}). Overwrite it with the local copy? This cannot be undone.`)) {
            setStatus({ ok: false, msg: 'Cancelled; storage file left untouched.' })
            return
          }
        }
      }
      if (remote) {
        const sameOwner = remote.header.ownerId === local.header.ownerId
        if (!sameOwner || compareCopies(local, remote, getSyncBase()) !== 'local') {
          const why = !sameOwner
            ? 'The storage file belongs to a DIFFERENT vault.'
            : 'The storage copy is newer than or has diverged from the local copy.'
          if (!window.confirm(`${why} Overwrite it with the local copy? This cannot be undone.`)) {
            setStatus({ ok: false, msg: 'Cancelled; storage copy left untouched.' })
            return
          }
        }
      }
      await forceMirrorToStorage(local)
      await refresh()
      const err = getLastSyncError()
      setStatus(err ? { ok: false, msg: err.message } : { ok: true, msg: 'Storage updated from local copy.' })
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  const clearDivergence = () => { setDivergence(null); setPreview(null); setPassphrase('') }

  // Preview: seal the live vault (so unsaved edits count) and merge it with the storage copy in memory only.
  const handlePreviewMerge = async () => {
    if (!divergence || !passphrase) return
    setBusy(true)
    setStatus(null)
    try {
      const sealedLocal = await vault.seal()
      const { vault: merged, summary } = await mergeCopies(sealedLocal, divergence.remote, passphrase)
      setPreview({ merged, summary })
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  // Replace the working vault with `persisted`: write local, set storage to match, swap the live instance.
  const applyResolution = async (persisted: PersistedVault, doneMsg: string, toStorage: boolean) => {
    const reopened = await VaultClass.open(persisted, passphrase)
    try {
      await writeLocalVaultFile(persisted)
      if (toStorage) {
        await forceMirrorToStorage(persisted)
        const err = getLastSyncError()
        if (err) throw err
      } else {
        await adoptStorageCopy(persisted)
      }
    } catch (err) {
      await reopened.discard().catch(() => { /* best effort */ })
      throw err
    }
    onVaultReplaced(reopened, persisted)
    clearDivergence()
    await refresh()
    setStatus({ ok: true, msg: doneMsg })
  }

  const handleMergeAndSave = async () => {
    if (!preview) return
    setBusy(true)
    setStatus(null)
    try {
      await applyResolution(preview.merged, 'Merged and saved to both the local copy and storage.', true)
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  const handleKeep = async (which: 'local' | 'external') => {
    if (!divergence || !passphrase) return
    const lost = which === 'local' ? 'the storage copy' : 'the local copy'
    if (!window.confirm(`Keep ${which} and discard ${lost}? Changes only in ${lost} will be lost. This cannot be undone.`)) return
    setBusy(true)
    setStatus(null)
    try {
      const persisted = which === 'local' ? await vault.seal() : divergence.remote
      await applyResolution(persisted, which === 'local' ? 'Kept local copy; storage updated.' : 'Kept storage copy; local copy replaced.', which === 'local')
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
        <button style={styles.btn} disabled={busy || !saved || input.trim() !== saved} title="Save the path first" onClick={() => { void handleTestRead() }}>
          Test read
        </button>
        <button style={styles.btn} disabled={busy || !saved} onClick={() => { void handleUseLocal() }}>
          Use local copy
        </button>
      </div>

      {divergence && (
        <div style={styles.banner}>
          <strong>Both copies were modified since your last sync.</strong>
          <div style={{ marginTop: 6 }}>
            Local is at sequence {divergence.local.header.sequenceNumber ?? 0}, storage at {divergence.remote.header.sequenceNumber ?? 0}.
            {preview
              ? ` ${preview.summary.onlyRemote + preview.summary.remoteWins + preview.summary.localWins + preview.summary.onlyLocal + preview.summary.identical} claims will be merged.`
              : ' Enter your passphrase to preview the merge.'}
          </div>
          {preview && (
            <ul style={styles.list}>
              <li>{preview.summary.identical} identical</li>
              <li>{preview.summary.localWins} differ — local version wins</li>
              <li>{preview.summary.remoteWins} differ — storage version wins</li>
              <li>{preview.summary.onlyLocal} only on this device</li>
              <li>{preview.summary.onlyRemote} only in storage (will be added)</li>
              <li>{preview.summary.deleted} removed (deleted on one side)</li>
              <li>{preview.summary.grantsRevoked} grants revoked, {preview.summary.grantsAdded} grants added</li>
            </ul>
          )}
          <input
            style={{ ...styles.input, marginTop: 10 }}
            type="password"
            placeholder="Vault passphrase"
            value={passphrase}
            autoComplete="off"
            disabled={busy}
            onChange={e => { setPassphrase(e.target.value); setPreview(null) }}
          />
          <div style={styles.row}>
            {preview
              ? <button style={styles.btn} disabled={busy} onClick={() => { void handleMergeAndSave() }}>Merge and save</button>
              : <button style={styles.btn} disabled={busy || !passphrase} onClick={() => { void handlePreviewMerge() }}>Preview merge</button>}
            <button style={styles.btn} disabled={busy || !passphrase} onClick={() => { void handleKeep('local') }}>Keep local</button>
            <button style={styles.btn} disabled={busy || !passphrase} onClick={() => { void handleKeep('external') }}>Keep external</button>
            <button style={styles.btn} disabled={busy} onClick={clearDivergence}>Dismiss</button>
          </div>
        </div>
      )}
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
  banner: {
    background: '#422006', border: '1px solid #92400e', borderRadius: 8, color: '#fde68a',
    fontSize: 13, marginTop: 16, maxWidth: 560, padding: '12px 14px',
  } as React.CSSProperties,
  list: { margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 } as React.CSSProperties,
  meta: { color: '#475569', fontSize: 11, marginTop: 24 } as React.CSSProperties,
} as const
