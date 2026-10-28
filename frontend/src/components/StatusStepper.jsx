import React from 'react';

const STAGES = [
  { key: 'fetching', label: '1. Fetching Archive' },
  { key: 'processing', label: '2. Filtering & Secrets' },
  { key: 'indexing', label: '3. AST Chunking & Vector Store' },
  { key: 'ready', label: '4. Ready for Q&A' },
];

export function StatusStepper({ repoData, onRefresh, refreshing }) {
  if (!repoData) return null;

  const { status, statusDetail, stats, error, owner, name, indexedCommitSha } = repoData;

  const getStepState = (stageKey) => {
    if (status === 'failed') return 'failed';

    const stageOrder = ['queued', 'fetching', 'processing', 'indexing', 'ready'];
    const currentIndex = stageOrder.indexOf(status);
    const stepIndex = stageOrder.indexOf(stageKey);

    if (currentIndex > stepIndex) return 'completed';
    if (currentIndex === stepIndex) return 'active';
    return 'pending';
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            {owner}/{name}
          </h3>
          {indexedCommitSha && (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Commit: {indexedCommitSha.slice(0, 7)}
            </span>
          )}
        </div>

        {status === 'ready' && (
          <button
            type="button"
            className="sample-chip"
            onClick={onRefresh}
            disabled={refreshing}
            style={{ padding: '6px 14px', fontSize: '0.85rem' }}
          >
            {refreshing ? 'Refreshing...' : '🔄 Check for Updates'}
          </button>
        )}
      </div>

      {/* Stepper track */}
      <div className="stepper-container">
        {STAGES.map((s, idx) => {
          const state = getStepState(s.key);
          return (
            <div key={s.key} className={`step-item ${state}`}>
              <div className="step-circle">{state === 'completed' ? '✓' : idx + 1}</div>
              <span className="step-label">{s.label}</span>
            </div>
          );
        })}
      </div>

      {/* Progress Detail */}
      <div style={{ marginTop: '12px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
        {statusDetail && <span>{statusDetail}</span>}
      </div>

      {/* Error display */}
      {status === 'failed' && error && (
        <div
          style={{
            marginTop: '12px',
            padding: '10px 14px',
            backgroundColor: 'rgba(248, 81, 73, 0.1)',
            border: '1px solid var(--danger-color)',
            borderRadius: '6px',
            color: 'var(--danger-color)',
            fontSize: '0.88rem',
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Stats row when ready */}
      {stats && (
        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexWrap: 'wrap' }}>
          <div className="stats-badge">
            <span style={{ color: 'var(--text-muted)' }}>Files:</span>
            <strong>{stats.files ?? 0}</strong>
          </div>
          <div className="stats-badge">
            <span style={{ color: 'var(--text-muted)' }}>Chunks:</span>
            <strong>{stats.chunks ?? 0}</strong>
          </div>
          <div className="stats-badge">
            <span style={{ color: 'var(--text-muted)' }}>Excluded (Secrets/Noise):</span>
            <strong>{stats.skippedFiles ?? 0}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
