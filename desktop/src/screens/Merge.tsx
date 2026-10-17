import React, { useState, useEffect, useCallback } from 'react'
import type { Vault, PersistedVault } from '@vault/vault'
import { mergeOrImport, type MergeChanges } from '@vault/merge'
import { Vault as VaultClass } from '@vault/vault'
import { listVaultFiles, readVaultFile, writeVaultFile, setActiveVaultName, deleteVaultFile } from '../tauriVault'
import type { VaultFileEntry } from '../tauriVault'
import { useI18n } from '../i18n'
import { UiError } from '../uiError'

interface Props {
  vault: Vault
  onVaultChanged: (vault: Vault, persisted: PersistedVault) => void
  /** Filename of the currently active vault — excluded from the merge list. */
  activeVaultName: string
}

interface MergeState {
  file: VaultFileEntry
  passphrase: string
  busy: boolean
  result: { ok: boolean; msg: string } | null
}

export default function Merge({ vault, onVaultChanged, activeVaultName }: Props) {
  const { t, formatNumber, describeError } = useI18n()
  const [others, setOthers] = useState<VaultFileEntry[]>([])
  const [mergeStates, setMergeStates] = useState<Record<string, MergeState>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void listVaultFiles().then(files => {
      const filtered = files.filter(f => f.name !== activeVaultName)
      setOthers(filtered)
      const initial: Record<string, MergeState> = {}
      for (const f of filtered) initial[f.name] = { file: f, passphrase: '', busy: false, result: null }
      setMergeStates(initial)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [activeVaultName])

  /** Describe changes a merge made beyond adding claims (deletions, overwrites, revoked grants). */
  const describeChanges = (s: MergeChanges): string => {
    const parts: string[] = []
    if (s.deleted > 0) parts.push(t('desktop.merge_note_deleted', { count: s.deleted, n: formatNumber(s.deleted) }))
    if (s.remoteWins > 0) parts.push(t('desktop.merge_note_replaced', { count: s.remoteWins, n: formatNumber(s.remoteWins) }))
    if (s.grantsRevoked > 0) parts.push(t('desktop.merge_note_grants_revoked', { count: s.grantsRevoked, n: formatNumber(s.grantsRevoked) }))
    return parts.join(', ')
  }

  const setPassphrase = (name: string, passphrase: string) =>
    setMergeStates(s => ({ ...s, [name]: { ...s[name], passphrase, result: null } }))

  const handleMerge = useCallback(async (name: string) => {
    const state = mergeStates[name]
    if (!state || state.busy || !state.passphrase) return

    setMergeStates(s => ({ ...s, [name]: { ...s[name], busy: true, result: null } }))

    try {
      // Read the other vault file using its specific name.
      const prev = setActiveVaultName as ((n: string) => void)
      prev(name)
      const otherPersisted = await readVaultFile()
      // Restore active vault name immediately.
      setActiveVaultName(activeVaultName)

      if (!otherPersisted) throw new UiError('desktop.merge_err_read')

      const other = await VaultClass.open(otherPersisted, state.passphrase)
      let added = 0
      let note = ''
      try {
        const res = mergeOrImport(vault, other)
        added = res.added
        note = describeChanges(res.changes)
      } finally {
        other.lock().catch(() => { /* best effort */ })
      }

      const persisted = await vault.seal()
      await writeVaultFile(persisted)
      onVaultChanged(vault, persisted)

      // Delete the source vault file after a successful merge
      await deleteVaultFile(name)
      setOthers(prev => prev.filter(f => f.name !== name))

      const addedMsg = added > 0 ? t('desktop.merge_added', { count: added, n: formatNumber(added) }) : t('desktop.merge_none')
      setMergeStates(s => ({
        ...s,
        [name]: { ...s[name], busy: false, passphrase: '', result: { ok: true, msg: t(note ? 'desktop.merge_done_note' : 'desktop.merge_done', { added: addedMsg, note }) } },
      }))
    } catch (err) {
      setActiveVaultName(activeVaultName)
      setMergeStates(s => ({
        ...s,
        [name]: { ...s[name], busy: false, result: { ok: false, msg: describeError(err) } },
      }))
    }
  }, [mergeStates, vault, activeVaultName, onVaultChanged, t, formatNumber, describeError])

  if (loading) return <div style={styles.empty}>{t('desktop.merge_loading')}</div>

  if (others.length === 0) {
    return (
      <div>
        <h1 style={styles.heading}>{t('desktop.merge_title')}</h1>
        <p style={styles.empty}>{t('desktop.merge_no_others')}</p>
      </div>
    )
  }

  return (
    <div>
      <h1 style={styles.heading}>{t('desktop.merge_title')}</h1>
      <p style={styles.subtitle}>{t('desktop.merge_subtitle')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {others.map(file => {
          const state = mergeStates[file.name]
          if (!state) return null
          const friendlyName = file.name.replace(/\.json$/, '').replace(/-/g, ' ')
          return (
            <div key={file.name} style={styles.card}>
              <div style={styles.cardHeader}>
                <span style={styles.cardName}>{friendlyName}</span>
                <span style={styles.cardMeta}>{t('desktop.merge_rev_owner', { revision: formatNumber(file.vault.header.sequenceNumber ?? 0), owner: file.vault.header.ownerId.slice(0, 8) })}</span>
              </div>
              <form
                onSubmit={e => { e.preventDefault(); void handleMerge(file.name) }}
                style={styles.form}
              >
                <input
                  style={styles.input}
                  type="password"
                  placeholder={t('desktop.passphrase')}
                  value={state.passphrase}
                  onChange={e => setPassphrase(file.name, e.target.value)}
                  autoComplete="off"
                  disabled={state.busy}
                />
                <button style={styles.btn} type="submit" disabled={state.busy || !state.passphrase}>
                  {state.busy ? t('desktop.merge_busy') : t('desktop.merge_btn')}
                </button>
              </form>
              {!state.result && (
                <div style={styles.warning}>
                  {t('desktop.merge_warning')}
                </div>
              )}
              {state.result && (
                <div style={{ fontSize: 12, color: state.result.ok ? '#22c55e' : '#f87171' }}>
                  {state.result.msg}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const styles = {
  heading: { fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 } as React.CSSProperties,
  subtitle: { fontSize: 13, color: '#64748b', lineHeight: 1.5 } as React.CSSProperties,
  empty: { color: '#64748b', fontSize: 13, marginTop: 16 } as React.CSSProperties,
  card: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  } as React.CSSProperties,
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } as React.CSSProperties,
  cardName: { fontSize: 14, fontWeight: 600, color: '#7dd3fc' } as React.CSSProperties,
  cardMeta: { fontSize: 11, color: '#64748b' } as React.CSSProperties,
  form: { display: 'flex', gap: 8 } as React.CSSProperties,
  input: {
    flex: 1,
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 6,
    color: '#f1f5f9',
    fontSize: 13,
    outline: 'none',
    padding: '8px 10px',
    minWidth: 0,
  } as React.CSSProperties,
  warning: {
    fontSize: 12,
    color: '#fbbf24',
    lineHeight: 1.5,
  } as React.CSSProperties,
  btn: {
    background: '#3b82f6',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 16px',
    flexShrink: 0,
  } as React.CSSProperties,
} as const
