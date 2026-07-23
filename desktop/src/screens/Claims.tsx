import React, { useState, useCallback } from 'react'
import type { Vault, Claim, PersistedVault } from '@vault/vault'
import { writeVaultFile } from '../tauriVault'

interface Props {
  vault: Vault
  onVaultChanged: (vault: Vault, persisted: PersistedVault) => void
}

const CLAIM_TYPES = [
  'given_name', 'family_name', 'email', 'phone', 'address',
  'birthdate', 'nationality', 'document_number', 'custom',
]

export default function Claims({ vault, onVaultChanged }: Props) {
  const [claims, setClaims] = useState<Claim[]>(() => vault.listClaims())
  const [editing, setEditing] = useState<Claim | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Form state
  const [type, setType] = useState('given_name')
  const [customType, setCustomType] = useState('')
  const [value, setValue] = useState('')

  const resetForm = () => {
    setType('given_name')
    setCustomType('')
    setValue('')
    setAdding(false)
    setEditing(null)
    setError(null)
  }

  const persistAndRefresh = useCallback(async () => {
    setBusy(true)
    try {
      // seal() serialises and encrypts but does NOT lock (lock() does that)
      const persisted = await vault.seal()
      await writeVaultFile(persisted)
      setClaims(vault.listClaims())
      onVaultChanged(vault, persisted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [vault, onVaultChanged])

  const handleAdd = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const resolvedType = type === 'custom' ? customType.trim() : type
    if (!resolvedType) { setError('Enter a claim type.'); return }
    if (!value.trim()) { setError('Enter a value.'); return }
    try {
      vault.addClaim({
        type: resolvedType,
        value: value.trim(),
        source: 'self-attested',
        verification: 'self',
        expiresAt: null,
        issuerDid: null,
      })
      await persistAndRefresh()
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [vault, type, customType, value, persistAndRefresh])

  const handleUpdate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    try {
      vault.updateClaim(editing.id, { value: value.trim() })
      await persistAndRefresh()
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [vault, editing, value, persistAndRefresh])

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm('Delete this claim?')) return
    try {
      vault.deleteClaim(id)
      await persistAndRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [vault, persistAndRefresh])

  const startEdit = (claim: Claim) => {
    setEditing(claim)
    setValue(String(claim.value))
    setAdding(false)
  }

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.heading}>Claims</h2>
        {!adding && !editing && (
          <button style={styles.btnPrimary} onClick={() => setAdding(true)}>+ Add claim</button>
        )}
      </div>

      {(adding || editing) && (
        <form onSubmit={editing ? handleUpdate : handleAdd} style={styles.form}>
          <h3 style={styles.formTitle}>{editing ? 'Edit claim' : 'Add claim'}</h3>
          {!editing && (
            <>
              <select style={styles.select} value={type} onChange={e => setType(e.target.value)}>
                {CLAIM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {type === 'custom' && (
                <input
                  style={styles.input}
                  type="text"
                  placeholder="Custom type"
                  value={customType}
                  onChange={e => setCustomType(e.target.value)}
                  required
                />
              )}
            </>
          )}
          {editing && <div style={styles.editLabel}>{editing.type}</div>}
          <input
            style={styles.input}
            type="text"
            placeholder="Value"
            value={value}
            onChange={e => setValue(e.target.value)}
            autoFocus
            required
          />
          {error && <div style={styles.error}>{error}</div>}
          <div style={styles.formRow}>
            <button style={styles.btnPrimary} type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save' : 'Add'}
            </button>
            <button style={styles.btnCancel} type="button" onClick={resetForm}>Cancel</button>
          </div>
        </form>
      )}

      {claims.length === 0 && !adding && (
        <div style={styles.empty}>No claims yet. Add one to get started.</div>
      )}

      <div style={styles.list}>
        {claims.map(claim => (
          <div key={claim.id} style={styles.card}>
            <div style={styles.cardBody}>
              <div style={styles.claimType}>{claim.type}</div>
              <div style={styles.claimValue}>{String(claim.value)}</div>
              <div style={styles.claimMeta}>
                <span style={badgeStyle(claim.verification)}>{claim.verification}</span>
                <span style={badgeStyle(claim.source)}>{claim.source}</span>
                <span style={styles.metaText}>{claim.issuedAt.slice(0, 10)}</span>
              </div>
            </div>
            <div style={styles.cardActions}>
              <button style={styles.iconBtn} onClick={() => startEdit(claim)}>✎</button>
              <button style={styles.iconBtnDanger} onClick={() => { void handleDelete(claim.id) }}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function badgeStyle(label: string): React.CSSProperties {
  const color = label === 'verified' ? '#22c55e'
    : label === 'self' || label === 'self-attested' ? '#7dd3fc'
    : '#64748b'
  return {
    fontSize: 10,
    color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    padding: '1px 5px',
    marginRight: 4,
  }
}

const styles = {
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  } as React.CSSProperties,
  heading: {
    fontSize: 20,
    fontWeight: 700,
    color: '#f1f5f9',
  } as React.CSSProperties,
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  } as React.CSSProperties,
  card: {
    background: '#1e293b',
    borderRadius: 8,
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
  } as React.CSSProperties,
  cardBody: { flex: 1 } as React.CSSProperties,
  cardActions: {
    display: 'flex',
    gap: 6,
    flexShrink: 0,
  } as React.CSSProperties,
  claimType: {
    fontSize: 12,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 2,
  } as React.CSSProperties,
  claimValue: {
    fontSize: 15,
    color: '#f1f5f9',
    marginBottom: 6,
    wordBreak: 'break-all' as const,
  } as React.CSSProperties,
  claimMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  metaText: {
    fontSize: 10,
    color: '#475569',
  } as React.CSSProperties,
  empty: {
    color: '#475569',
    fontSize: 14,
    textAlign: 'center' as const,
    padding: '40px 0',
  } as React.CSSProperties,
  form: {
    background: '#1e293b',
    borderRadius: 8,
    padding: 16,
    marginBottom: 20,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    maxWidth: 440,
  } as React.CSSProperties,
  formTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#f1f5f9',
    marginBottom: 4,
  } as React.CSSProperties,
  editLabel: {
    fontSize: 12,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties,
  input: {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 7,
    color: '#f1f5f9',
    fontSize: 14,
    outline: 'none',
    padding: '9px 12px',
  } as React.CSSProperties,
  select: {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 7,
    color: '#f1f5f9',
    fontSize: 14,
    padding: '9px 12px',
    outline: 'none',
  } as React.CSSProperties,
  formRow: {
    display: 'flex',
    gap: 8,
  } as React.CSSProperties,
  btnPrimary: {
    background: '#3b82f6',
    border: 'none',
    borderRadius: 7,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 16px',
  } as React.CSSProperties,
  btnCancel: {
    background: 'transparent',
    border: '1px solid #334155',
    borderRadius: 7,
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 13,
    padding: '8px 16px',
  } as React.CSSProperties,
  iconBtn: {
    background: 'transparent',
    border: 'none',
    borderRadius: 5,
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 14,
    padding: '3px 6px',
  } as React.CSSProperties,
  iconBtnDanger: {
    background: 'transparent',
    border: 'none',
    borderRadius: 5,
    color: '#f87171',
    cursor: 'pointer',
    fontSize: 14,
    padding: '3px 6px',
  } as React.CSSProperties,
  error: {
    color: '#f87171',
    fontSize: 12,
  } as React.CSSProperties,
} as const
