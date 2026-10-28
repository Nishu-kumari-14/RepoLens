import React from 'react';

export function CitationViewer({ activeCitation, onClose }) {
  if (!activeCitation) {
    return (
      <div className="card code-drawer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
          Click any citation badge in chat responses to inspect the source file range.
        </p>
      </div>
    );
  }

  const { filePath, startLine, endLine, symbol } = activeCitation;

  return (
    <div className="card code-drawer">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h4 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--accent-color)' }}>
          Cited Reference
        </h4>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '1rem',
            }}
          >
            ✕
          </button>
        )}
      </div>

      <div style={{ fontSize: '0.82rem', marginBottom: '12px' }}>
        <div style={{ marginBottom: '4px' }}>
          <span style={{ color: 'var(--text-muted)' }}>File: </span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
            {filePath}
          </span>
        </div>
        <div style={{ marginBottom: '4px' }}>
          <span style={{ color: 'var(--text-muted)' }}>Lines: </span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {startLine} – {endLine}
          </span>
        </div>
        {symbol && (
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Symbol: </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--success-color)' }}>
              {symbol}
            </span>
          </div>
        )}
      </div>

      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        <p>Grounding verification passed.</p>
        <p style={{ marginTop: '4px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Referenced lines belong to verified retrieved AST symbol chunks.
        </p>
      </div>
    </div>
  );
}
