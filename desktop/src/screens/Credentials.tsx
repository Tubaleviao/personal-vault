import React, { useState, useCallback } from 'react'
import type { Vault, Claim, PersistedVault } from '@vault/vault'
import { CREDENTIAL_CLAIM_TYPE } from '@vault/form-filler'
import type { CredentialValue } from '@vault/form-filler'
import { writeVaultFile } from '../tauriVault'
import { useI18n } from '../i18n'

interface Props {
  vault: Vault
  onVaultChanged: (vault: Vault, persisted: PersistedVault) => void
}

function listCredentials(vault: Vault): Claim[] {
  return vault.listClaims().filter(c => c.type === CREDENTIAL_CLAIM_TYPE)
}

export default function Credentials({ vault, onVaultChanged }: Props) {
  const { t, describeError } = useI18n()
  const [credentials, setCredentials] = useState<Claim[]>(() => listCredentials(vault))
  const [revealed, setRevealed] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm(t('desktop.credentials_confirm_delete'))) return
    try {
      vault.deleteClaim(id)
      const persisted = await vault.seal()
      await writeVaultFile(persisted)
      setCredentials(listCredentials(vault))
      onVaultChanged(vault, persisted)
    } catch (err) {
      setError(err)
    }
  }, [vault, onVaultChanged, t])

  return (
    <div>
      <h2 style={styles.heading}>{t('desktop.nav_credentials')}</h2>
      {error != null && <div style={styles.error}>{describeError(error)}</div>}
      {credentials.length === 0 && <div style={styles.empty}>{t('desktop.credentials_empty')}</div>}
      <div style={styles.list}>
        {credentials.map(claim => {
          const v = claim.value as CredentialValue
          return (
            <div key={claim.id} style={styles.card}>
              <div style={styles.cardBody}>
                <div style={styles.origin}>{v.origin}</div>
                <div style={styles.username}>{v.username}</div>
                <div style={styles.password}>
                  {revealed === claim.id ? v.password : '••••••••'}
                </div>
              </div>
              <div style={styles.actions}>
                <button
                  style={styles.iconBtn}
                  onClick={() => setRevealed(revealed === claim.id ? null : claim.id)}
                >
                  {revealed === claim.id ? t('desktop.hide') : t('desktop.show')}
                </button>
                <button style={styles.iconBtnDanger} title={t('desktop.delete')} aria-label={t('desktop.delete')} onClick={() => { void handleDelete(claim.id) }}>✕</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const styles = {
  heading: { fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 20 } as React.CSSProperties,
  list: { display: 'flex', flexDirection: 'column' as const, gap: 10 } as React.CSSProperties,
  card: {
    background: '#1e293b', borderRadius: 8, padding: '12px 14px',
    display: 'flex', alignItems: 'flex-start', gap: 10,
  } as React.CSSProperties,
  cardBody: { flex: 1 } as React.CSSProperties,
  origin: { fontSize: 13, color: '#7dd3fc', wordBreak: 'break-all' as const } as React.CSSProperties,
  username: { fontSize: 15, color: '#f1f5f9', marginTop: 2 } as React.CSSProperties,
  password: { fontSize: 13, color: '#94a3b8', marginTop: 2, fontFamily: 'monospace', wordBreak: 'break-all' as const } as React.CSSProperties,
  actions: { display: 'flex', gap: 6, flexShrink: 0 } as React.CSSProperties,
  iconBtn: {
    background: 'transparent', border: 'none', borderRadius: 5, color: '#94a3b8',
    cursor: 'pointer', fontSize: 12, padding: '3px 6px',
  } as React.CSSProperties,
  iconBtnDanger: {
    background: 'transparent', border: 'none', borderRadius: 5, color: '#f87171',
    cursor: 'pointer', fontSize: 14, padding: '3px 6px',
  } as React.CSSProperties,
  empty: { color: '#475569', fontSize: 14, textAlign: 'center' as const, padding: '40px 0' } as React.CSSProperties,
  error: { color: '#f87171', fontSize: 12, marginBottom: 10 } as React.CSSProperties,
} as const
