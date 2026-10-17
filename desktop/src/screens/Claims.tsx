import React, { useState, useCallback } from 'react'
import type { Vault, Claim, PersistedVault } from '@vault/vault'
import { writeVaultFile } from '../tauriVault'
import { CREDENTIAL_CLAIM_TYPE } from '@vault/form-filler'
import { useI18n } from '../i18n'
import { UiError } from '../uiError'

interface Props {
  vault: Vault
  onVaultChanged: (vault: Vault, persisted: PersistedVault) => void
}

const CLAIM_TYPES = [
  'given_name', 'family_name', 'email', 'phone', 'address',
  'birthdate', 'nationality', 'document_number', 'custom',
]

export default function Claims({ vault, onVaultChanged }: Props) {
  const { t, tOr, formatDate, describeError } = useI18n()
  const [claims, setClaims] = useState<Claim[]>(() => vault.listClaims().filter(c => c.type !== CREDENTIAL_CLAIM_TYPE))
  const [editing, setEditing] = useState<Claim | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<unknown>(null)
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
      setClaims(vault.listClaims().filter(c => c.type !== CREDENTIAL_CLAIM_TYPE))
      onVaultChanged(vault, persisted)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }, [vault, onVaultChanged])

  const handleAdd = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const resolvedType = type === 'custom' ? customType.trim() : type
    if (!resolvedType) { setError(new UiError('desktop.claims_err_type')); return }
    if (!value.trim()) { setError(new UiError('desktop.claims_err_value')); return }
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
      setError(err)
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
      setError(err)
    }
  }, [vault, editing, value, persistAndRefresh])

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm(t('desktop.claims_confirm_delete'))) return
    try {
      vault.deleteClaim(id)
      await persistAndRefresh()
    } catch (err) {
      setError(err)
    }
  }, [vault, persistAndRefresh, t])

  const startEdit = (claim: Claim) => {
    setEditing(claim)
    setValue(String(claim.value))
    setAdding(false)
  }

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.heading}>{t('desktop.nav_claims')}</h2>
        {!adding && !editing && (
          <button style={styles.btnPrimary} onClick={() => setAdding(true)}>{t('desktop.claims_add_btn')}</button>
        )}
      </div>

      {(adding || editing) && (
        <form onSubmit={editing ? handleUpdate : handleAdd} style={styles.form}>
          <h3 style={styles.formTitle}>{editing ? t('desktop.claims_edit_title') : t('desktop.claims_add_title')}</h3>
          {!editing && (
            <>
              <select style={styles.select} value={type} onChange={e => setType(e.target.value)}>
                {CLAIM_TYPES.map(ct => <option key={ct} value={ct}>{tOr('desktop.claim_type_', ct)}</option>)}
              </select>
              {type === 'custom' && (
                <input
                  style={styles.input}
                  type="text"
                  placeholder={t('desktop.claims_custom_type')}
                  value={customType}
                  onChange={e => setCustomType(e.target.value)}
                  required
                />
              )}
            </>
          )}
          {editing && <div style={styles.editLabel}>{tOr('desktop.claim_type_', editing.type)}</div>}
          <input
            style={styles.input}
            type="text"
            placeholder={t('desktop.claims_value')}
            value={value}
            onChange={e => setValue(e.target.value)}
            autoFocus
            required
          />
          {error != null && <div style={styles.error}>{describeError(error)}</div>}
          <div style={styles.formRow}>
            <button style={styles.btnPrimary} type="submit" disabled={busy}>
              {busy ? t('desktop.saving') : editing ? t('desktop.save') : t('desktop.add')}
            </button>
            <button style={styles.btnCancel} type="button" onClick={resetForm}>{t('desktop.cancel')}</button>
          </div>
        </form>
      )}

      {claims.length === 0 && !adding && (
        <div style={styles.empty}>{t('desktop.claims_empty')}</div>
      )}

      <div style={styles.list}>
        {claims.map(claim => (
          <div key={claim.id} style={styles.card}>
            <div style={styles.cardBody}>
              <div style={styles.claimType}>{tOr('desktop.claim_type_', claim.type)}</div>
              <div style={styles.claimValue}>{String(claim.value)}</div>
              <div style={styles.claimMeta}>
                <span style={badgeStyle(claim.verification)}>{tOr('desktop.verification_', claim.verification)}</span>
                <span style={badgeStyle(claim.source)}>{tOr('desktop.source_', claim.source)}</span>
                <span style={styles.metaText}>{formatDate(claim.issuedAt, { dateStyle: 'medium' })}</span>
              </div>
            </div>
            <div style={styles.cardActions}>
              <button style={styles.iconBtn} title={t('desktop.edit')} aria-label={t('desktop.edit')} onClick={() => startEdit(claim)}>✎</button>
              <button style={styles.iconBtnDanger} title={t('desktop.delete')} aria-label={t('desktop.delete')} onClick={() => { void handleDelete(claim.id) }}>✕</button>
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
