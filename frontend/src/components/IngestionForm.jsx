import React, { useState } from 'react';
import { isValidGitHubUrl } from '../services/api.js';

export function IngestionForm({ onSubmit, loading }) {
  const [url, setUrl] = useState('');
  const [validationError, setValidationError] = useState('');

  const sampleRepos = [
    'https://github.com/expressjs/cookie-parser',
    'https://github.com/sindresorhus/is',
  ];

  const handleSubmit = (e) => {
    e.preventDefault();
    setValidationError('');

    const trimmed = url.trim();
    if (!trimmed) {
      setValidationError('Please enter a GitHub repository URL.');
      return;
    }

    if (!isValidGitHubUrl(trimmed)) {
      setValidationError('Invalid format. Accepted: https://github.com/{owner}/{repo}');
      return;
    }

    onSubmit(trimmed);
  };

  const handleSelectSample = (sampleUrl) => {
    setUrl(sampleUrl);
    setValidationError('');
    onSubmit(sampleUrl);
  };

  return (
    <div className="card">
      <h2 className="form-title">Index a GitHub Repository</h2>
      <form onSubmit={handleSubmit}>
        <div className="url-input-group">
          <input
            type="text"
            className="url-input"
            placeholder="https://github.com/owner/repository"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
          />
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Submitting...' : 'Analyze Repository'}
          </button>
        </div>
      </form>

      {validationError && (
        <p style={{ color: 'var(--danger-color)', fontSize: '0.85rem', marginBottom: '10px' }}>
          {validationError}
        </p>
      )}

      <div className="samples-row">
        <span>Try a sample:</span>
        {sampleRepos.map((sample) => (
          <button
            key={sample}
            type="button"
            className="sample-chip"
            onClick={() => handleSelectSample(sample)}
            disabled={loading}
          >
            {sample.replace('https://github.com/', '')}
          </button>
        ))}
      </div>
    </div>
  );
}
