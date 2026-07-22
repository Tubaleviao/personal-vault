import React, { useState, useCallback } from 'react'
import type { Vault } from '@vault/vault'
import { Vault as VaultClass } from '@vault/vault'
import type { PersistedVault } from '@vault/vault'
import { generateMnemonicBundle, restoreFromMnemonic } from '@vault/recovery'
import { generateDID } from '@vault/did'
import { readVaultFile, writeVaultFile, vaultFileExists } from '../tauriVault'

interface Props {
  onUnlocked: (vault: Vault, persisted: PersistedVault) => void
}

type Mode = 'detect' | 'create' | 'open'

export default function Unlock({ onUnlocked }: Props) {
  const [mode, setMode] = useState<Mode>('detect')
  const [passphrase, setPassphrase] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [newMnemonic, setNewMnemonic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Detect whether a vault already exists the first time the component mounts
  React.useEffect(() => {
    void vaultFileExists().then(exists => setMode(exists ? 'open' : 'create'))
  }, [])

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const bundle = await generateMnemonicBundle()
      const { did } = await generateDID()
      const vault = await VaultClass.create({
        passphrase,
        did,
        displayName: displayName || undefined,
        mnemonicCommitment: bundle.mnemonicCommitment,
      })
      const persisted = await vault.seal()
      await writeVaultFile(persisted)
      setNewMnemonic(bundle.mnemonic)
      // Re-open after user acknowledges mnemonic
      const reopened = await VaultClass.open(persisted, passphrase)
      onUnlocked(reopened, persisted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [passphrase, displayName, busy, onUnlocked])

  const handleOpen = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const persisted = await readVaultFile()
      if (!persisted) throw new Error('No vault file found. Create a new vault instead.')
      const vault = await VaultClass.open(persisted, passphrase)
      if (mnemonic.trim()) {
        const bundle = await restoreFromMnemonic(mnemonic)
        if (!bundle) throw new Error('Invalid recovery phrase.')
        // Store keypair in session state — passed to Sync screen later
        ;(vault as unknown as { _recoveryKeypair: unknown })._recoveryKeypair = bundle.keypair
      }
      onUnlocked(vault, persisted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [passphrase, mnemonic, busy, onUnlocked])

  if (mode === 'detect') {
    return <div style={styles.center}><div style={styles.spinner}>Loading…</div></div>
  }

  return (
    <div style={styles.center}>
      <div style={styles.card}>
        <h1 style={styles.title}>Personal Vault</h1>
        <p style={styles.subtitle}>
          {mode === 'create' ? 'Create a new vault' : 'Unlock your vault'}
        </p>

        {newMnemonic && (
          <div style={styles.mnemonicBox}>
            <p style={styles.mnemonicLabel}>Write down your recovery phrase — it won't be shown again:</p>
            <p style={styles.mnemonicPhrase}>{newMnemonic}</p>
          </div>
        )}

        <form
          onSubmit={mode === 'create' ? handleCreate : handleOpen}
          style={styles.form}
        >
          {mode === 'create' && (
            <input
              style={styles.input}
              type="text"
              placeholder="Display name (optional)"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          )}
          <input
            style={styles.input}
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
            autoFocus
            required
          />
          {mode === 'open' && (
            <input
              style={styles.input}
              type="password"
              placeholder="Recovery phrase (optional — needed for sync)"
              value={mnemonic}
              onChange={e => setMnemonic(e.target.value)}
              autoComplete="off"
            />
          )}
          {error && <div style={styles.error}>{error}</div>}
          <button style={styles.btn} type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'create' ? 'Create vault' : 'Unlock'}
          </button>
        </form>

        <button
          style={styles.switchLink}
          onClick={() => { setMode(mode === 'create' ? 'open' : 'create'); setError(null) }}
        >
          {mode === 'create' ? 'Already have a vault? Unlock' : 'New vault? Create one'}
        </button>
      </div>
    </div>
  )
}

const styles = {
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
  } as React.CSSProperties,
  spinner: {
    color: '#64748b',
  } as React.CSSProperties,
  card: {
    background: '#1e293b',
    borderRadius: 12,
    padding: '36px 32px',
    width: 380,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    boxShadow: '0 8px 32px rgba(0,0,0,.4)',
  } as React.CSSProperties,
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: '#7dd3fc',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  subtitle: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center' as const,
    marginBottom: 4,
  } as React.CSSProperties,
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  } as React.CSSProperties,
  input: {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 7,
    color: '#f1f5f9',
    fontSize: 14,
    outline: 'none',
    padding: '10px 12px',
  } as React.CSSProperties,
  btn: {
    background: '#3b82f6',
    border: 'none',
    borderRadius: 7,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    padding: '10px',
    marginTop: 4,
  } as React.CSSProperties,
  error: {
    color: '#f87171',
    fontSize: 12,
  } as React.CSSProperties,
  switchLink: {
    background: 'none',
    border: 'none',
    color: '#475569',
    cursor: 'pointer',
    fontSize: 12,
    textDecoration: 'underline',
    textAlign: 'center' as const,
    marginTop: 4,
  } as React.CSSProperties,
  mnemonicBox: {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 7,
    padding: '12px',
    marginBottom: 4,
  } as React.CSSProperties,
  mnemonicLabel: {
    color: '#fbbf24',
    fontSize: 12,
    marginBottom: 8,
  } as React.CSSProperties,
  mnemonicPhrase: {
    color: '#f1f5f9',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 1.6,
    wordSpacing: '0.3em',
  } as React.CSSProperties,
} as const
