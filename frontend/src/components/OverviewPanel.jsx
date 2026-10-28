import React from 'react';

export function OverviewPanel({ overview }) {
  if (!overview) return null;

  return (
    <div className="card">
      <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '10px' }}>
        Repository Overview
      </h3>
      <div
        style={{
          fontSize: '0.88rem',
          lineHeight: '1.6',
          whiteSpace: 'pre-wrap',
          maxHeight: '400px',
          overflowY: 'auto',
          paddingRight: '6px',
        }}
      >
        {overview}
      </div>
    </div>
  );
}
