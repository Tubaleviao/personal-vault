import React, { useState, useEffect, useCallback } from 'react'
import { Vault as VaultClass } from '@vault/vault'
import { mergeVaultsWithSummary as mergeCopies } from '@vault/merge'
import type { Vault, PersistedVault, MergeSummary } from '@vault/vault'
import {
  getStoragePath, setStoragePath, getSyncBase, readStorageVault, getLastSyncError, compareCopies,
  readVaultFile, writeLocalVaultFile, adoptStorageCopy, forceMirrorToStorage, StorageError,
} from '../tauriVault'
import { useI18n } from '../i18n'
import { UiError } from '../uiError'

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

export default function Storage({ vault, onVaultReplaced }: Props) {
  const { t, formatNumber, describeError: describe } = useI18n()
  const num = (n: number) => formatNumber(n)
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
    const last = getLastSyncError()
    setSyncError(cfgError ?? (last ? describe(last) : null))
  }, [describe])

  useEffect(() => { void refresh() }, [refresh])

  const handleSave = async () => {
    setBusy(true)
    setStatus(null)
    try {
      await setStoragePath(input.trim() || null)
      await refresh()
      setStatus({ ok: true, msg: input.trim() ? t('desktop.storage_saved') : t('desktop.storage_disabled') })
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
        ? t('desktop.storage_up_to_date', { seq: num(remote.header.sequenceNumber ?? 0) })
        : newer === 'conflict'
          ? t('desktop.storage_diverged')
        : newer === 'remote'
          ? t('desktop.storage_remote_newer', { remote: num(remote.header.sequenceNumber ?? 0), local: num(local?.header.sequenceNumber ?? 0) })
          : t('desktop.storage_local_newer', { local: num(local?.header.sequenceNumber ?? 0), remote: num(remote.header.sequenceNumber ?? 0) })
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
      if (!local) throw new UiError('desktop.storage_err_no_local')
      // Overwriting is destructive: confirm unless storage is empty, older, or already identical.
      // Only a missing file may be overwritten without asking; an unreadable or
      // foreign file needs explicit confirmation.
      let remote: Awaited<ReturnType<typeof readStorageVault>> | null = null
      try {
        remote = await readStorageVault()
      } catch (err) {
        if (!(err instanceof StorageError && err.code === 'NOT_FOUND')) {
          if (!window.confirm(t('desktop.storage_confirm_unverified', { detail: describe(err) }))) {
            setStatus({ ok: false, msg: t('desktop.storage_cancelled_file') })
            return
          }
        }
      }
      if (remote) {
        const sameOwner = remote.header.ownerId === local.header.ownerId
        if (!sameOwner || compareCopies(local, remote, getSyncBase()) !== 'local') {
          const why = !sameOwner
            ? t('desktop.storage_why_different')
            : t('desktop.storage_why_newer')
          if (!window.confirm(t('desktop.storage_confirm_overwrite', { why }))) {
            setStatus({ ok: false, msg: t('desktop.storage_cancelled_copy') })
            return
          }
        }
      }
      await forceMirrorToStorage(local)
      await refresh()
      const err = getLastSyncError()
      setStatus(err ? { ok: false, msg: describe(err) } : { ok: true, msg: t('desktop.storage_updated') })
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
    } catch (err) {
      await reopened.discard().catch(() => { /* best effort */ })
      throw err
    }
    // The local file now holds `persisted`, so the live vault must be swapped even if the storage
    // step fails; otherwise the next save would overwrite the resolved local file with stale state.
    let storageErr: unknown = null
    try {
      if (toStorage) {
        await forceMirrorToStorage(persisted)
        const err = getLastSyncError()
        if (err) throw err
      } else {
        await adoptStorageCopy(persisted)
      }
    } catch (err) {
      storageErr = err
    }
    onVaultReplaced(reopened, persisted)
    clearDivergence()
    await refresh()
    if (storageErr) throw storageErr
    setStatus({ ok: true, msg: doneMsg })
  }

  // The forced write below replaces storage; refuse if it changed since the divergence was detected.
  const assertStorageUnchanged = async () => {
    if (!divergence) return
    const fresh = await readStorageVault(saved)
    if (JSON.stringify(fresh) !== JSON.stringify(divergence.remote)) {
      clearDivergence()
      throw new UiError('desktop.storage_err_changed')
    }
  }

  const handleMergeAndSave = async () => {
    if (!preview || !divergence) return
    setBusy(true)
    setStatus(null)
    try {
      await assertStorageUnchanged()
      // Re-merge from a fresh seal: edits made since the preview must not be lost.
      const sealedLocal = await vault.seal()
      const { vault: merged } = await mergeCopies(sealedLocal, divergence.remote, passphrase)
      await applyResolution(merged, t('desktop.storage_merged_saved'), true)
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  const handleKeep = async (which: 'local' | 'external') => {
    if (!divergence || !passphrase) return
    if (!window.confirm(t(which === 'local' ? 'desktop.storage_confirm_keep_local' : 'desktop.storage_confirm_keep_external'))) return
    setBusy(true)
    setStatus(null)
    try {
      if (which === 'local') await assertStorageUnchanged()
      const persisted = which === 'local' ? await vault.seal() : divergence.remote
      await applyResolution(persisted, which === 'local' ? t('desktop.storage_kept_local') : t('desktop.storage_kept_external'), which === 'local')
    } catch (err) {
      setStatus({ ok: false, msg: describe(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2 style={styles.heading}>{t('desktop.nav_storage')}</h2>
      <p style={styles.hint}>
        {t('desktop.storage_hint', { example: '/home/you/Dropbox/vault.json' })}
      </p>

      <label style={styles.label}>{t('desktop.storage_path_label')}</label>
      <input
        style={styles.input}
        value={input}
        placeholder={t('desktop.storage_err_NOT_CONFIGURED')}
        onChange={e => setInput(e.target.value)}
        spellCheck={false}
      />
      <div style={styles.row}>
        <button style={styles.btn} disabled={busy} onClick={() => { void handleSave() }}>{t('desktop.save')}</button>
        <button style={styles.btn} disabled={busy || !saved || input.trim() !== saved} title={t('desktop.storage_save_first')} onClick={() => { void handleTestRead() }}>
          {t('desktop.storage_test_read')}
        </button>
        <button style={styles.btn} disabled={busy || !saved} onClick={() => { void handleUseLocal() }}>
          {t('desktop.storage_use_local')}
        </button>
      </div>

      {divergence && (
        <div style={styles.banner}>
          <strong>{t('desktop.storage_both_modified')}</strong>
          <div style={{ marginTop: 6 }}>
            {t('desktop.storage_sequences', { local: num(divergence.local.header.sequenceNumber ?? 0), remote: num(divergence.remote.header.sequenceNumber ?? 0) })}
            {' '}
            {preview
              ? t('desktop.storage_will_merge', {
                count: preview.summary.onlyRemote + preview.summary.remoteWins + preview.summary.localWins + preview.summary.onlyLocal + preview.summary.identical,
                n: num(preview.summary.onlyRemote + preview.summary.remoteWins + preview.summary.localWins + preview.summary.onlyLocal + preview.summary.identical),
              })
              : t('desktop.storage_enter_passphrase')}
          </div>
          {preview && (
            <ul style={styles.list}>
              <li>{t('desktop.storage_sum_identical', { n: num(preview.summary.identical) })}</li>
              <li>{t('desktop.storage_sum_local_wins', { n: num(preview.summary.localWins) })}</li>
              <li>{t('desktop.storage_sum_remote_wins', { n: num(preview.summary.remoteWins) })}</li>
              <li>{t('desktop.storage_sum_only_local', { n: num(preview.summary.onlyLocal) })}</li>
              <li>{t('desktop.storage_sum_only_remote', { n: num(preview.summary.onlyRemote) })}</li>
              <li>{t('desktop.storage_sum_deleted', { n: num(preview.summary.deleted) })}</li>
              <li>{t('desktop.storage_sum_grants', { revoked: num(preview.summary.grantsRevoked), added: num(preview.summary.grantsAdded) })}</li>
            </ul>
          )}
          <input
            style={{ ...styles.input, marginTop: 10 }}
            type="password"
            placeholder={t('desktop.storage_passphrase')}
            value={passphrase}
            autoComplete="off"
            disabled={busy}
            onChange={e => { setPassphrase(e.target.value); setPreview(null) }}
          />
          <div style={styles.row}>
            {preview
              ? <button style={styles.btn} disabled={busy} onClick={() => { void handleMergeAndSave() }}>{t('desktop.storage_merge_save')}</button>
              : <button style={styles.btn} disabled={busy || !passphrase} onClick={() => { void handlePreviewMerge() }}>{t('desktop.storage_preview_merge')}</button>}
            <button style={styles.btn} disabled={busy || !passphrase} onClick={() => { void handleKeep('local') }}>{t('desktop.storage_keep_local')}</button>
            <button style={styles.btn} disabled={busy || !passphrase} onClick={() => { void handleKeep('external') }}>{t('desktop.storage_keep_external')}</button>
            <button style={styles.btn} disabled={busy} onClick={clearDivergence}>{t('desktop.dismiss')}</button>
          </div>
        </div>
      )}
      {status && (
        <div style={status.ok ? styles.ok : styles.err}>{status.msg}</div>
      )}
      {syncError && <div style={styles.err}>{t('desktop.storage_sync_failed', { detail: syncError })}</div>}
      <div style={styles.meta}>
        {t('desktop.storage_meta', { did: vault.owner.did.slice(0, 20) })}{' · '}{saved ? t('desktop.storage_syncing_to', { path: saved }) : t('desktop.storage_sync_disabled')}
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
