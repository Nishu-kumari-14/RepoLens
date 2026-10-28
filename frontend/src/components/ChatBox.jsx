import React, { useState, useRef, useEffect } from 'react';

export function ChatBox({ messages, onSend, streaming, onSelectCitation }) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);

  const sampleQuestions = [
    'What does this project do?',
    'How is cookie parsing implemented?',
    'What are the key dependencies?',
  ];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || streaming) return;
    onSend(input.trim());
    setInput('');
  };

  const handleSuggestionClick = (q) => {
    if (streaming) return;
    onSend(q);
  };

  /**
   * Renders assistant answer text, converting [path:start-end] citations into clickable pills.
   */
  const renderMessageContent = (content, citations = []) => {
    if (!content) return null;

    // Pattern matching [path:12-34]
    const regex = /\[([^:\]\s]+):(\d+)-(\d+)\]/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const matchIndex = match.index;
      if (matchIndex > lastIndex) {
        parts.push(content.slice(lastIndex, matchIndex));
      }

      const raw = match[0];
      const filePath = match[1];
      const startLine = parseInt(match[2], 10);
      const endLine = parseInt(match[3], 10);

      const matchingCitation = citations.find(
        (c) => c.filePath.includes(filePath) || filePath.includes(c.filePath)
      ) || { filePath, startLine, endLine };

      parts.push(
        <button
          key={`${filePath}-${startLine}-${endLine}-${matchIndex}`}
          type="button"
          className="citation-pill"
          onClick={() => onSelectCitation(matchingCitation)}
          title={`Inspect ${filePath}:${startLine}-${endLine}`}
        >
          📎 {filePath}:{startLine}–{endLine}
        </button>
      );

      lastIndex = matchIndex + raw.length;
    }

    if (lastIndex < content.length) {
      parts.push(content.slice(lastIndex));
    }

    return (
      <div style={{ whiteSpace: 'pre-wrap' }}>
        {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : p))}
      </div>
    );
  };

  return (
    <div className="card chat-window">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <p style={{ fontSize: '1rem', marginBottom: '8px' }}>Ask any question about this codebase.</p>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              All answers are strictly grounded with verified line range citations.
            </p>
          </div>
        ) : (
          messages.map((m, idx) => (
            <div key={idx} className={`chat-bubble ${m.role}`}>
              {m.role === 'user' ? (
                <span>{m.content}</span>
              ) : (
                renderMessageContent(m.content, m.citations)
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {messages.length === 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '8px 0' }}>
          {sampleQuestions.map((q) => (
            <button
              key={q}
              type="button"
              className="sample-chip"
              onClick={() => handleSuggestionClick(q)}
              disabled={streaming}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="chat-input"
          placeholder="Ask a question about this repository..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={streaming}
        />
        <button type="submit" className="btn-primary" disabled={streaming || !input.trim()}>
          {streaming ? 'Answering...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
