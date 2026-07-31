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

interface Props {
  onUnlocked: (vault: Vault, persisted: PersistedVault) => void
}

type Mode = 'detect' | 'pick' | 'create' | 'open' | 'merge'

export default function Unlock({ onUnlocked }: Props) {
  const [mode, setMode] = useState<Mode>('detect')
  const [passphrase, setPassphrase] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [vaultFiles, setVaultFiles] = useState<VaultFileEntry[]>([])
  const [otherFiles, setOtherFiles] = useState<VaultFileEntry[]>([])

  // After vault creation, hold the mnemonic + persisted blob until the user
  // acknowledges the phrase and clicks Continue.
  const [pendingCreate, setPendingCreate] = useState<{
    mnemonic: string
    persisted: PersistedVault
  } | null>(null)

  // After unlock, the vault is held here while we offer to merge secondary vaults.
  const [pendingUnlock, setPendingUnlock] = useState<{
    vault: Vault
    persisted: PersistedVault
  } | null>(null)

  const [mergePassphrase, setMergePassphrase] = useState('')
  const [mergeStatus, setMergeStatus] = useState<{ ok: boolean; msg: string } | null>(null)

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

  const handlePickVault = useCallback((file: VaultFileEntry, all: VaultFileEntry[]) => {
    setActiveVaultName(file.name)
    setOtherFiles(all.filter(f => f.name !== file.name))
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
      // Generate a unique filename so we never overwrite an existing vault.
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const newName = `vault-${ts}.json`
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

      if (otherFiles.length > 0) {
        // Offer merge before transitioning — user can skip by clicking "Continue"
        setPendingUnlock({ vault, persisted })
        setMode('merge')
      } else {
        onUnlocked(vault, persisted)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [passphrase, mnemonic, busy, onUnlocked, otherFiles])

  // ── Merge ─────────────────────────────────────────────────────────────────────

  const handleMerge = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pendingUnlock || busy) return
    setBusy(true)
    setMergeStatus(null)
    try {
      let added = 0
      for (const file of otherFiles) {
        try {
          const other = await VaultClass.open(file.vault, mergePassphrase)
          const claims = other.listClaims()
          other.lock().catch(() => { /* best effort */ })
          for (const claim of claims) {
            const before = pendingUnlock.vault.listClaims().length
            pendingUnlock.vault.importClaim(claim)
            if (pendingUnlock.vault.listClaims().length > before) added++
          }
        } catch {
          // wrong passphrase for this file — skip
        }
      }
      const persisted = await pendingUnlock.vault.seal()
      await writeVaultFile(persisted)
      setPendingUnlock(prev => prev ? { vault: prev.vault, persisted } : prev)
      setMergeStatus({ ok: true, msg: added > 0 ? `Merged ${added} claim${added === 1 ? '' : 's'}` : 'No new claims to merge' })
    } catch (err) {
      setMergeStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [pendingUnlock, mergePassphrase, busy, otherFiles])

  const handleSkipMerge = useCallback(() => {
    if (!pendingUnlock) return
    onUnlocked(pendingUnlock.vault, pendingUnlock.persisted)
  }, [pendingUnlock, onUnlocked])

  const handleContinueAfterMerge = useCallback(() => {
    if (!pendingUnlock) return
    onUnlocked(pendingUnlock.vault, pendingUnlock.persisted)
  }, [pendingUnlock, onUnlocked])

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
                onClick={() => handlePickVault(file, vaultFiles)}
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

  if (mode === 'merge') {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <h1 style={styles.title}>Personal Vault</h1>
          <p style={styles.subtitle}>Import from another vault</p>
          <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}>
            {otherFiles.length === 1 ? `"${otherFiles[0].name}"` : `${otherFiles.length} other vault files`} found in the vault directory.
            Enter {otherFiles.length === 1 ? 'its' : 'their'} passphrase to merge claims into the vault you just opened.
          </p>
          {mergeStatus ? (
            <>
              <div style={{ color: mergeStatus.ok ? '#22c55e' : '#f87171', fontSize: 13, textAlign: 'center' }}>
                {mergeStatus.msg}
              </div>
              <button style={styles.btn} onClick={handleContinueAfterMerge} disabled={busy}>
                Continue
              </button>
            </>
          ) : (
            <form onSubmit={e => { void handleMerge(e) }} style={styles.form}>
              <input
                style={styles.input}
                type="password"
                placeholder="Other vault's passphrase"
                value={mergePassphrase}
                onChange={e => setMergePassphrase(e.target.value)}
                autoFocus
                autoComplete="off"
              />
              <button style={styles.btn} type="submit" disabled={busy}>
                {busy ? 'Merging…' : 'Merge claims'}
              </button>
              <button style={styles.switchLink} type="button" onClick={handleSkipMerge} disabled={busy}>
                Skip — continue without merging
              </button>
            </form>
          )}
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
