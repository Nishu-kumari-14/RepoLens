/**
 * Swappable LLM adapter for answer generation.
 * Default provider: Google Gemini API (via AI Studio free-tier).
 *
 * Interface:
 *   generate({ system, prompt, modelId, apiKey }) -> Promise<string>
 *   generateStream({ system, prompt, modelId, apiKey, onChunk }) -> Promise<string>
 */
import { config } from '../config/env.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Builds standard Gemini API payload with system instructions and user prompt.
 */
function buildGeminiPayload(system, prompt) {
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  if (system && system.trim().length > 0) {
    payload.systemInstruction = {
      parts: [{ text: system }],
    };
  }

  return payload;
}

/**
 * Generates text completion from LLM.
 *
 * @param {object} params
 * @param {string} params.system
 * @param {string} params.prompt
 * @param {string} [params.modelId]
 * @param {string} [params.apiKey]
 * @returns {Promise<string>}
 */
export async function generate({ system, prompt, modelId, apiKey }) {
  const activeModel = modelId || config.llm.modelId;
  const activeKey = apiKey || config.keys.geminiApiKey;

  if (!activeModel) throw new Error('LLM_MODEL_ID is not configured in .env');
  if (!activeKey) throw new Error('GEMINI_API_KEY is not configured in .env');

  const url = `${GEMINI_API_BASE}/${activeModel}:generateContent?key=${activeKey}`;
  const payload = buildGeminiPayload(system, prompt);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`LLM generation failed (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Invalid response format from LLM: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return text;
}

/**
 * Streams text completion from LLM using SSE.
 *
 * @param {object} params
 * @param {string} params.system
 * @param {string} params.prompt
 * @param {string} [params.modelId]
 * @param {string} [params.apiKey]
 * @param {Function} [params.onChunk] Callback for each emitted text fragment
 * @returns {Promise<string>} Full accumulated text
 */
export async function generateStream({ system, prompt, modelId, apiKey, onChunk = () => {} }) {
  const activeModel = modelId || config.llm.modelId;
  const activeKey = apiKey || config.keys.geminiApiKey;

  if (!activeModel) throw new Error('LLM_MODEL_ID is not configured in .env');
  if (!activeKey) throw new Error('GEMINI_API_KEY is not configured in .env');

  const url = `${GEMINI_API_BASE}/${activeModel}:streamGenerateContent?alt=sse&key=${activeKey}`;
  const payload = buildGeminiPayload(system, prompt);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`LLM stream generation failed (${response.status}): ${errorText.slice(0, 300)}`);
  }

  let fullText = '';

  // Stream reader handling SSE chunks
  if (response.body) {
    const reader = response.body.getReader ? response.body.getReader() : null;
    if (reader) {
      const decoder = new TextDecoder('utf8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete trailing line

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') continue;
            try {
              const data = JSON.parse(jsonStr);
              const chunkText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (chunkText) {
                fullText += chunkText;
                onChunk(chunkText);
              }
            } catch {
              // Ignore non-JSON SSE lines
            }
          }
        }
      }
    } else {
      // Fallback for non-stream body (Node stream)
      for await (const chunk of response.body) {
        const text = chunk.toString('utf8');
        for (const line of text.split('\n')) {
          if (line.trim().startsWith('data:')) {
            try {
              const data = JSON.parse(line.trim().slice(5).trim());
              const fragment = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (fragment) {
                fullText += fragment;
                onChunk(fragment);
              }
            } catch {
              // Ignore parse error on heartbeats
            }
          }
        }
      }
    }
  }

  return fullText;
}
