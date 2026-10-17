import React, { useMemo } from 'react'
import type { Vault } from '@vault/vault'
import { formatAuditLog, verifyChain } from '@vault/audit'
import { useI18n } from '../i18n'

interface Props {
  vault: Vault
}

export default function Audit({ vault }: Props) {
  const { t, tOr, formatDate, formatNumber } = useI18n()
  const log = useMemo(() => vault.getAuditLog(), [vault])
  const formatted = useMemo(() => formatAuditLog(log), [log])
  const chain = useMemo(() => verifyChain(log), [log])

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.heading}>{t('desktop.nav_audit')}</h2>
        <div style={chain.valid ? styles.badgeOk : styles.badgeFail}>
          {chain.valid
            ? t('desktop.audit_chain_intact', { count: chain.entryCount, n: formatNumber(chain.entryCount) })
            : t('desktop.audit_tampered', { entry: chain.firstBrokenAt ?? '?' })}
        </div>
      </div>

      {formatted.length === 0 && (
        <div style={styles.empty}>{t('desktop.audit_empty')}</div>
      )}

      <div style={styles.list}>
        {formatted.map((line, i) => (
          <div key={i} style={styles.entry}>
            <div style={styles.entryLeft}>
              <span style={actionBadge(line.action)}>{tOr('desktop.audit_action_', line.action)}</span>
              <span style={styles.actor}>{line.actor}</span>
              {line.grantId && (
                <span style={styles.grantId} title={line.grantId}>
                  {t('desktop.audit_grant', { id: line.grantId.slice(0, 8) })}
                </span>
              )}
            </div>
            <div style={styles.entryRight}>
              {line.detail && <span style={styles.detail}>{line.detail}</span>}
              <span style={styles.hash}>{line.entryHash}</span>
              <span style={styles.ts}>{formatDate(line.timestamp)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function actionBadge(action: string): React.CSSProperties {
  const color = action.startsWith('claim') ? '#7dd3fc'
    : action.startsWith('grant') ? '#a78bfa'
    : action.startsWith('vault') ? '#fbbf24'
    : '#64748b'
  return {
    fontSize: 11,
    color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    padding: '1px 6px',
    flexShrink: 0,
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
  badgeOk: {
    background: 'rgba(34,197,94,.15)',
    border: '1px solid #22c55e',
    borderRadius: 6,
    color: '#22c55e',
    fontSize: 12,
    padding: '4px 10px',
  } as React.CSSProperties,
  badgeFail: {
    background: 'rgba(248,113,113,.15)',
    border: '1px solid #f87171',
    borderRadius: 6,
    color: '#f87171',
    fontSize: 12,
    padding: '4px 10px',
  } as React.CSSProperties,
  empty: {
    color: '#475569',
    fontSize: 14,
    textAlign: 'center' as const,
    padding: '40px 0',
  } as React.CSSProperties,
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  } as React.CSSProperties,
  entry: {
    background: '#1e293b',
    borderRadius: 7,
    padding: '10px 14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  entryLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  entryRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  actor: {
    fontSize: 12,
    color: '#94a3b8',
  } as React.CSSProperties,
  grantId: {
    fontSize: 10,
    color: '#475569',
    fontFamily: 'monospace',
  } as React.CSSProperties,
  detail: {
    fontSize: 11,
    color: '#64748b',
    maxWidth: 200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  hash: {
    fontSize: 10,
    color: '#475569',
    fontFamily: 'monospace',
  } as React.CSSProperties,
  ts: {
    fontSize: 11,
    color: '#475569',
    flexShrink: 0,
  } as React.CSSProperties,
} as const
