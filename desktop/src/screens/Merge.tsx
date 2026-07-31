import React, { useState, useEffect, useCallback } from 'react'
import type { Vault, PersistedVault } from '@vault/vault'
import { Vault as VaultClass } from '@vault/vault'
import { listVaultFiles, readVaultFile, writeVaultFile, setActiveVaultName } from '../tauriVault'
import type { VaultFileEntry } from '../tauriVault'

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

      if (!otherPersisted) throw new Error('Could not read vault file.')

      const other = await VaultClass.open(otherPersisted, state.passphrase)
      const claims = other.listClaims()
      other.lock().catch(() => { /* best effort */ })

      let added = 0
      for (const claim of claims) {
        const before = vault.listClaims().length
        vault.importClaim(claim)
        if (vault.listClaims().length > before) added++
      }

      const persisted = await vault.seal()
      await writeVaultFile(persisted)
      onVaultChanged(vault, persisted)

      setMergeStates(s => ({
        ...s,
        [name]: { ...s[name], busy: false, passphrase: '', result: { ok: true, msg: added > 0 ? `Merged ${added} claim${added === 1 ? '' : 's'}` : 'No new claims to merge' } },
      }))
    } catch (err) {
      setActiveVaultName(activeVaultName)
      setMergeStates(s => ({
        ...s,
        [name]: { ...s[name], busy: false, result: { ok: false, msg: err instanceof Error ? err.message : String(err) } },
      }))
    }
  }, [mergeStates, vault, activeVaultName, onVaultChanged])

  if (loading) return <div style={styles.empty}>Loading vault list…</div>

  if (others.length === 0) {
    return (
      <div>
        <h1 style={styles.heading}>Import from another vault</h1>
        <p style={styles.empty}>No other vault files found in the vault directory.</p>
      </div>
    )
  }

  return (
    <div>
      <h1 style={styles.heading}>Import from another vault</h1>
      <p style={styles.subtitle}>Enter the passphrase of the vault you want to merge into this one. Claims that already exist are skipped.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {others.map(file => {
          const state = mergeStates[file.name]
          if (!state) return null
          const friendlyName = file.name.replace(/\.json$/, '').replace(/-/g, ' ')
          return (
            <div key={file.name} style={styles.card}>
              <div style={styles.cardHeader}>
                <span style={styles.cardName}>{friendlyName}</span>
                <span style={styles.cardMeta}>Rev {file.vault.header.sequenceNumber ?? 0} · {file.vault.header.ownerId.slice(0, 8)}</span>
              </div>
              <form
                onSubmit={e => { e.preventDefault(); void handleMerge(file.name) }}
                style={styles.form}
              >
                <input
                  style={styles.input}
                  type="password"
                  placeholder="Passphrase"
                  value={state.passphrase}
                  onChange={e => setPassphrase(file.name, e.target.value)}
                  autoComplete="off"
                  disabled={state.busy}
                />
                <button style={styles.btn} type="submit" disabled={state.busy || !state.passphrase}>
                  {state.busy ? 'Merging…' : 'Merge'}
                </button>
              </form>
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
