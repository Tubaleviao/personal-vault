import React, { useState, useCallback } from 'react'
import type { Vault } from '@vault/vault'
import { Vault as VaultClass } from '@vault/vault'
import type { PersistedVault } from '@vault/vault'
import { generateMnemonicBundle, restoreFromMnemonic } from '@vault/recovery'
import { generateDID } from '@vault/did'
import {
  readVaultFile, writeVaultFile, listVaultFiles, setActiveVaultName, vaultFileExists,
} from '../tauriVault'
import type { VaultFileEntry } from '../tauriVault'

/**
 * Generate a unique vault filename.
 * Uses the display name if provided (sanitized), otherwise a unix timestamp.
 * Appends a timestamp suffix if the base name is already taken.
 */
function uniqueVaultFilename(displayName: string, existing: string[]): string {
  const taken = new Set(existing)
  const ts = Date.now()

  const base = displayName.trim()
    ? displayName.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    : String(ts)

  const candidate = `${base}.json`
  if (!taken.has(candidate)) return candidate

  // Name already taken — append timestamp suffix to make it unique.
  return `${base}-${ts}.json`
}

interface Props {
  onUnlocked: (vault: Vault, persisted: PersistedVault) => void
}

type Mode = 'detect' | 'pick' | 'create' | 'open'

export default function Unlock({ onUnlocked }: Props) {
  const [mode, setMode] = useState<Mode>('detect')
  const [passphrase, setPassphrase] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [vaultFiles, setVaultFiles] = useState<VaultFileEntry[]>([])
  // After vault creation, hold the mnemonic + persisted blob until the user
  // acknowledges the phrase and clicks Continue.
  const [pendingCreate, setPendingCreate] = useState<{
    mnemonic: string
    persisted: PersistedVault
  } | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Discover vault files on mount to decide the initial mode.
  React.useEffect(() => {
    void (async () => {
      try {
        const files = await listVaultFiles()
        if (files.length === 0) {
          // listVaultFiles skips invalid JSON — check raw existence before
          // showing Create, so a corrupt vault.json doesn't get silently overwritten.
          const rawExists = await vaultFileExists()
          setMode(rawExists ? 'open' : 'create')
        } else {
          // Always show the picker so the user can see which vault they're unlocking,
          // even when only one is found.
          setVaultFiles(files)
          setMode('pick')
        }
      } catch {
        setMode('create')
      }
    })()
  }, [])

  // ── Vault picker ─────────────────────────────────────────────────────────────

  const handlePickVault = useCallback((file: VaultFileEntry) => {
    setActiveVaultName(file.name)
    setMode('open')
  }, [])

  // ── Create ───────────────────────────────────────────────────────────────────

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
      const newName = uniqueVaultFilename(displayName, vaultFiles.map(f => f.name))
      setActiveVaultName(newName)
      await writeVaultFile(persisted)
      setPendingCreate({ mnemonic: bundle.mnemonic, persisted })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [passphrase, displayName, busy])

  const handleContinueAfterMnemonic = useCallback(async () => {
    if (!pendingCreate || busy) return
    setBusy(true)
    setError(null)
    try {
      const vault = await VaultClass.open(pendingCreate.persisted, passphrase)
      onUnlocked(vault, pendingCreate.persisted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [pendingCreate, passphrase, busy, onUnlocked])

  // ── Open ─────────────────────────────────────────────────────────────────────

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
        ;(vault as unknown as { _recoveryKeypair: unknown })._recoveryKeypair = bundle.keypair
      }
      onUnlocked(vault, persisted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [passphrase, mnemonic, busy, onUnlocked])

  // ── Render ────────────────────────────────────────────────────────────────────

  if (mode === 'detect') {
    return <div style={styles.center}><div style={styles.spinner}>Loading…</div></div>
  }

  if (mode === 'pick') {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.title}>Personal Vault</h1>
          <p style={styles.subtitle}>
            {vaultFiles.length === 1 ? 'One vault found — click it to unlock' : `${vaultFiles.length} vaults found — choose one to unlock`}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {vaultFiles.map(file => (
              <button
                key={file.name}
                style={styles.pickerItem}
                onClick={() => handlePickVault(file)}
              >
                <div style={styles.pickerName}>{file.name}</div>
                <div style={styles.pickerMeta}>
                  Revision {file.vault.header.sequenceNumber ?? 0}
                  {' · '}owner {file.vault.header.ownerId.slice(0, 8)}
                </div>
              </button>
            ))}
          </div>
          <button style={styles.switchLink} onClick={() => setMode('create')}>
            Create a new vault instead
          </button>
        </div>
      </div>
    )
  }

  // Mnemonic acknowledgment step: shown after vault creation, before opening.
  if (pendingCreate) {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.title}>Personal Vault</h1>
          <p style={styles.subtitle}>Your vault has been created</p>
          <div style={styles.mnemonicBox}>
            <p style={styles.mnemonicLabel}>
              Write down your recovery phrase — it will not be shown again:
            </p>
            <p style={styles.mnemonicPhrase}>{pendingCreate.mnemonic}</p>
          </div>
          {error && <div style={styles.error}>{error}</div>}
          <button style={styles.btn} onClick={() => { void handleContinueAfterMnemonic() }} disabled={busy}>
            {busy ? 'Please wait…' : 'I have written it down — Continue'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.center}>
      <div style={styles.card}>
        <h1 style={styles.title}>Personal Vault</h1>
        <p style={styles.subtitle}>
          {mode === 'create' ? 'Create a new vault' : 'Unlock your vault'}
        </p>

        <form
          onSubmit={mode === 'create' ? e => { void handleCreate(e) } : e => { void handleOpen(e) }}
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
          onClick={() => {
            setMode(mode === 'create' ? 'open' : 'create')
            setError(null)
          }}
        >
          {mode === 'create' ? 'Already have a vault? Unlock' : 'New vault? Create one'}
        </button>

        {mode === 'open' && vaultFiles.length > 0 && (
          <button style={styles.switchLink} onClick={() => setMode('pick')}>
            ← Back to vault list
          </button>
        )}
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
  pickerItem: {
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 7,
    cursor: 'pointer',
    padding: '12px 14px',
    textAlign: 'left' as const,
    transition: 'border-color 0.15s',
    width: '100%',
  } as React.CSSProperties,
  pickerName: {
    color: '#7dd3fc',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 3,
  } as React.CSSProperties,
  pickerMeta: {
    color: '#64748b',
    fontSize: 11,
  } as React.CSSProperties,
} as const
