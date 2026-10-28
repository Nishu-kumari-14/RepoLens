import React, { useState, useEffect } from 'react';
import { IngestionForm } from './components/IngestionForm.jsx';
import { StatusStepper } from './components/StatusStepper.jsx';
import { OverviewPanel } from './components/OverviewPanel.jsx';
import { ChatBox } from './components/ChatBox.jsx';
import { CitationViewer } from './components/CitationViewer.jsx';
import {
  submitRepository,
  getRepository,
  refreshRepository,
  streamChat,
} from './services/api.js';

export function App() {
  const [repoId, setRepoId] = useState(null);
  const [repoData, setRepoData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [activeCitation, setActiveCitation] = useState(null);

  // Poll repository status while in progress
  useEffect(() => {
    if (!repoId) return;

    let timerId;
    const poll = async () => {
      try {
        const data = await getRepository(repoId);
        setRepoData(data);

        const inProgress = ['queued', 'fetching', 'processing', 'indexing'].includes(
          data.status
        );
        if (inProgress) {
          timerId = setTimeout(poll, 1500);
        } else {
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        console.error('Polling error:', err);
        setLoading(false);
        setRefreshing(false);
      }
    };

    poll();

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [repoId]);

  const handleUrlSubmit = async (url) => {
    setLoading(true);
    setRepoData(null);
    setMessages([]);
    setActiveCitation(null);

    try {
      const res = await submitRepository(url);
      setRepoId(res.repositoryId);
    } catch (err) {
      alert(`Submission failed: ${err.message}`);
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!repoId || refreshing) return;
    setRefreshing(true);

    try {
      await refreshRepository(repoId);
      // Re-trigger polling
      const data = await getRepository(repoId);
      setRepoData(data);
    } catch (err) {
      alert(`Refresh failed: ${err.message}`);
      setRefreshing(false);
    }
  };

  const handleSendMessage = async (question) => {
    if (!repoId || streaming) return;

    const userMessage = { role: 'user', content: question, citations: [] };
    const pendingAssistantMessage = { role: 'assistant', content: '', citations: [] };

    setMessages((prev) => [...prev, userMessage, pendingAssistantMessage]);
    setStreaming(true);

    let accumulatedAnswer = '';

    await streamChat({
      repoId,
      question,
      sessionId: `session_${repoId}`,
      onToken: (token) => {
        accumulatedAnswer += token;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: accumulatedAnswer,
            citations: [],
          };
          return updated;
        });
      },
      onComplete: ({ answer, citations }) => {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: answer,
            citations: citations || [],
          };
          return updated;
        });
        setStreaming(false);
      },
      onError: (err) => {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: `Error: ${err.message}`,
            citations: [],
          };
          return updated;
        });
        setStreaming(false);
      },
    });
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="brand">
          <span style={{ fontSize: '1.8rem' }}>🔍</span>
          <div>
            <h1>RepoLens</h1>
            <p className="tagline">Code-grounded repository intelligence with verified line citations</p>
          </div>
        </div>
      </header>

      <main>
        <IngestionForm onSubmit={handleUrlSubmit} loading={loading} />

        <StatusStepper
          repoData={repoData}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />

        {repoData && repoData.status === 'ready' && (
          <div className="dashboard-grid">
            <div>
              <ChatBox
                messages={messages}
                onSend={handleSendMessage}
                streaming={streaming}
                onSelectCitation={setActiveCitation}
              />
            </div>
            <div>
              <CitationViewer
                activeCitation={activeCitation}
                onClose={() => setActiveCitation(null)}
              />
              {repoData.overview && <OverviewPanel overview={repoData.overview} />}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
