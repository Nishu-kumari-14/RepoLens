/**
 * Mongoose schemas for RepoLens.
 * Three collections: repositories, chat_sessions, messages.
 */
import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

// ─── Repository ───────────────────────────────────────────────────────────────

const repositorySchema = new Schema(
  {
    owner: { type: String, required: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    defaultBranch: { type: String, default: 'main' },
    indexedCommitSha: { type: String, default: null },

    // Ingestion lifecycle status
    status: {
      type: String,
      enum: ['queued', 'fetching', 'processing', 'indexing', 'ready', 'failed'],
      default: 'queued',
    },
    statusDetail: { type: String, default: '' },
    error: { type: String, default: null },

    // Stats updated after each run
    stats: {
      files: { type: Number, default: 0 },
      chunks: { type: Number, default: 0 },
      skippedFiles: { type: Number, default: 0 },
    },

    // Embedding model metadata — used to detect model changes
    embeddingModel: { type: String, default: '' },

    // Overview text (Phase 6)
    overview: { type: String, default: null },

    // Resumable progress: last completed batch index
    batchOffset: { type: Number, default: 0 },
  },
  {
    timestamps: true, // createdAt, updatedAt
    collection: 'repositories',
  }
);

// Unique per owner+name
repositorySchema.index({ owner: 1, name: 1 }, { unique: true });

// ─── ChatSession ──────────────────────────────────────────────────────────────

const chatSessionSchema = new Schema(
  {
    repositoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Repository',
      required: true,
    },
    title: { type: String, default: 'New conversation' },
  },
  {
    timestamps: true,
    collection: 'chat_sessions',
  }
);

// ─── Message ─────────────────────────────────────────────────────────────────

const messageSchema = new Schema(
  {
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatSession',
      required: true,
    },
    repositoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Repository',
      required: true,
    },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    citations: [
      {
        filePath: String,
        startLine: Number,
        endLine: Number,
        symbol: String,
      },
    ],
  },
  {
    timestamps: true,
    collection: 'messages',
  }
);

messageSchema.index({ sessionId: 1, createdAt: 1 });

// ─── Exports ──────────────────────────────────────────────────────────────────
// Guard against OverwriteModelError when module is hot-reloaded in tests.

export const Repository = models.Repository || model('Repository', repositorySchema);
export const ChatSession = models.ChatSession || model('ChatSession', chatSessionSchema);
export const Message = models.Message || model('Message', messageSchema);
