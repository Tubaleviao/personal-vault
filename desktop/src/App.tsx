import React, { useState, useCallback } from 'react'
import type { Vault } from '@vault/vault'
import type { PersistedVault } from '@vault/vault'
import Unlock from './screens/Unlock'
import Claims from './screens/Claims'
import Audit from './screens/Audit'
import Sync from './screens/Sync'
import { writeVaultFile } from './tauriVault'

type Screen = 'claims' | 'audit' | 'sync'

interface UnlockedState {
  vault: Vault
  persisted: PersistedVault
}

const NAV: { id: Screen; label: string }[] = [
  { id: 'claims', label: 'Claims' },
  { id: 'audit',  label: 'Audit log' },
  { id: 'sync',   label: 'Sync' },
]

export default function App() {
  const [unlocked, setUnlocked] = useState<UnlockedState | null>(null)
  const [screen, setScreen] = useState<Screen>('claims')
  const [lockError, setLockError] = useState<string | null>(null)

  const handleUnlocked = useCallback((vault: Vault, persisted: PersistedVault) => {
    setUnlocked({ vault, persisted })
    setScreen('claims')
    setLockError(null)
  }, [])

  const handleLock = useCallback(async () => {
    if (!unlocked) return
    try {
      // lock() seals the vault, zeros the master key, and returns the persisted blob
      const persisted = await unlocked.vault.lock()
      await writeVaultFile(persisted)
      setUnlocked(null)
    } catch (err) {
      setLockError(err instanceof Error ? err.message : String(err))
    }
  }, [unlocked])

  if (!unlocked) {
    return <Unlock onUnlocked={handleUnlocked} />
  }

  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>Personal Vault</div>
        <div style={styles.didShort} title={unlocked.vault.owner.did}>
          {unlocked.vault.owner.did.slice(0, 20)}…
        </div>
        <nav style={styles.nav}>
          {NAV.map(({ id, label }) => (
            <button
              key={id}
              style={{ ...styles.navBtn, ...(screen === id ? styles.navBtnActive : {}) }}
              onClick={() => setScreen(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <button style={styles.lockBtn} onClick={() => { void handleLock() }}>
          Lock vault
        </button>
        {lockError && <div style={styles.errorSmall}>{lockError}</div>}
      </aside>

      <main style={styles.main}>
        {screen === 'claims' && (
          <Claims vault={unlocked.vault} onVaultChanged={
            (v, p) => setUnlocked({ vault: v, persisted: p })
          } />
        )}
        {screen === 'audit' && (
          <Audit vault={unlocked.vault} />
        )}
        {screen === 'sync' && (
          <Sync vault={unlocked.vault} persisted={unlocked.persisted} onSynced={
            (v, p) => setUnlocked({ vault: v, persisted: p })
          } />
        )}
      </main>
    </div>
  )
}

// ── Inline styles (mirrors extension dark theme) ──────────────────────────────

const styles = {
  shell: {
    display: 'flex',
    height: '100vh',
    overflow: 'hidden',
  } as React.CSSProperties,
  sidebar: {
    width: 200,
    flexShrink: 0,
    background: '#0a1120',
    borderRight: '1px solid #1e293b',
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '20px 12px 16px',
    gap: 4,
  } as React.CSSProperties,
  logo: {
    fontSize: 15,
    fontWeight: 600,
    color: '#7dd3fc',
    marginBottom: 6,
  } as React.CSSProperties,
  didShort: {
    fontSize: 10,
    color: '#475569',
    marginBottom: 20,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    cursor: 'default',
  } as React.CSSProperties,
  nav: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    flex: 1,
  } as React.CSSProperties,
  navBtn: {
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    padding: '8px 10px',
    textAlign: 'left' as const,
  } as React.CSSProperties,
  navBtnActive: {
    background: '#1e293b',
    color: '#f1f5f9',
  } as React.CSSProperties,
  lockBtn: {
    background: 'transparent',
    border: '1px solid #f87171',
    borderRadius: 6,
    color: '#f87171',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    padding: '7px 12px',
    marginTop: 16,
  } as React.CSSProperties,
  errorSmall: {
    color: '#f87171',
    fontSize: 11,
    marginTop: 4,
  } as React.CSSProperties,
  main: {
    flex: 1,
    overflow: 'auto',
    padding: 28,
  } as React.CSSProperties,
} as const
