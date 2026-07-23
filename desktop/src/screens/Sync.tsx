import React, { useState, useCallback } from 'react'
import type { Vault, PersistedVault } from '@vault/vault'
import { syncVault } from '@vault/relay'
import type { Ed25519Keypair } from '@vault/crypto'
import { writeVaultFile } from '../tauriVault'

interface Props {
  vault: Vault
  persisted: PersistedVault
  onSynced: (vault: Vault, persisted: PersistedVault) => void
}

const RELAY_URL_KEY = 'vault_relay_url'

export default function Sync({ vault, persisted, onSynced }: Props) {
  const [relayUrl, setRelayUrl] = useState(() => localStorage.getItem(RELAY_URL_KEY) ?? '')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const recoveryKeypair: Ed25519Keypair | undefined =
    (vault as unknown as { _recoveryKeypair?: Ed25519Keypair })._recoveryKeypair

  const saveRelayUrl = useCallback(() => {
    const trimmed = relayUrl.trim()
    localStorage.setItem(RELAY_URL_KEY, trimmed)
    setStatus('Relay URL saved.')
  }, [relayUrl])

  const handleSync = useCallback(async () => {
    setError(null)
    setStatus(null)
    const trimmed = relayUrl.trim()
    if (!trimmed) { setError('Enter a relay URL first.'); return }
    if (!recoveryKeypair) {
      setError('Recovery phrase keypair not loaded. Re-unlock the vault and enter your recovery phrase.')
      return
    }
    setBusy(true)
    try {
      const localBlob = await vault.seal()
      await writeVaultFile(localBlob)

      const { blob: syncedBlob, result } = await syncVault(
        { url: trimmed, ownerId: vault.owner.id },
        localBlob,
        recoveryKeypair.privateKey,
        recoveryKeypair.publicKey,
      )

      if (result.action === 'pulled') {
        // Remote was newer — we need to re-open the blob
        // We cannot re-open without the passphrase here; update persisted state
        await writeVaultFile(syncedBlob)
        // Signal parent to reload from disk on next unlock
        setStatus(`Pulled newer vault from relay (${result.updatedAt}).`)
        onSynced(vault, syncedBlob)
      } else {
        setStatus(`Sync complete: ${result.action} (${result.updatedAt}).`)
        onSynced(vault, syncedBlob)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [vault, persisted, relayUrl, recoveryKeypair, onSynced])

  return (
    <div>
      <h2 style={styles.heading}>Sync</h2>
      <p style={styles.description}>
        Push or pull your encrypted vault blob to/from a Cloudflare Worker relay.
        Your relay never sees plaintext — only the XChaCha20 ciphertext.
      </p>

      <div style={styles.section}>
        <label style={styles.label}>Relay URL</label>
        <div style={styles.row}>
          <input
            style={styles.input}
            type="url"
            placeholder="https://your-vault.workers.dev"
            value={relayUrl}
            onChange={e => setRelayUrl(e.target.value)}
            autoComplete="off"
          />
          <button style={styles.btnSecondary} onClick={saveRelayUrl} disabled={busy}>
            Save
          </button>
        </div>
      </div>

      <div style={styles.section}>
        <label style={styles.label}>Recovery keypair</label>
        <div style={recoveryKeypair ? styles.keypairOk : styles.keypairMissing}>
          {recoveryKeypair
            ? 'Keypair loaded from recovery phrase.'
            : 'Not loaded — re-unlock the vault and enter your 12-word recovery phrase.'}
        </div>
      </div>

      <button
        style={styles.btnPrimary}
        onClick={() => { void handleSync() }}
        disabled={busy || !recoveryKeypair}
      >
        {busy ? 'Syncing…' : 'Sync now'}
      </button>

      {status && <div style={styles.statusOk}>{status}</div>}
      {error && <div style={styles.error}>{error}</div>}
    </div>
  )
}

const styles = {
  heading: {
    fontSize: 20,
    fontWeight: 700,
    color: '#f1f5f9',
    marginBottom: 10,
  } as React.CSSProperties,
  description: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 24,
    lineHeight: 1.6,
  } as React.CSSProperties,
  section: {
    marginBottom: 20,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    maxWidth: 480,
  } as React.CSSProperties,
  label: {
    fontSize: 12,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    gap: 8,
  } as React.CSSProperties,
  input: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 7,
    color: '#f1f5f9',
    fontSize: 14,
    outline: 'none',
    padding: '9px 12px',
    flex: 1,
  } as React.CSSProperties,
  btnPrimary: {
    background: '#3b82f6',
    border: 'none',
    borderRadius: 7,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    padding: '10px 24px',
    marginBottom: 16,
  } as React.CSSProperties,
  btnSecondary: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 7,
    color: '#f1f5f9',
    cursor: 'pointer',
    fontSize: 13,
    padding: '9px 14px',
  } as React.CSSProperties,
  keypairOk: {
    fontSize: 13,
    color: '#22c55e',
  } as React.CSSProperties,
  keypairMissing: {
    fontSize: 13,
    color: '#f87171',
  } as React.CSSProperties,
  statusOk: {
    color: '#22c55e',
    fontSize: 13,
    marginTop: 4,
  } as React.CSSProperties,
  error: {
    color: '#f87171',
    fontSize: 13,
    marginTop: 4,
  } as React.CSSProperties,
} as const
