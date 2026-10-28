# RepoLens Implementation Plan

## 1. Executive Summary (Understanding of the Project)
RepoLens is a zero-cost, end-to-end RAG system designed to ingest, index, and query public GitHub repositories with strict line-level citations. Ingestion safely fetches repository archives, filters out binaries and sensitive files, and parses code into semantic units using `web-tree-sitter` (WASM) with line-based window fallbacks. Chunks are embedded via a resilient embedding client featuring batching, jittered exponential backoff, rate limits, and resumable checkpoints, before being stored in an embedded LanceDB database. Queries employ hybrid retrieval—combining vector and BM25 full-text search merged via Reciprocal Rank Fusion (RRF)—to assemble context for an LLM that streams verified, cited answers. Job orchestration and repository metadata persist in MongoDB Atlas with crash recovery on startup, while retrieval accuracy is continuously benchmarked using an evaluation harness tracking MRR and Recall@k.

---

## 2. Architecture & Design Decisions

The following key decisions are locked for implementation:

1. **WASM Grammars Distribution (`web-tree-sitter`)**:
   - Use the `tree-sitter-wasms` package (version pinned).
   - Provide a setup script (`scripts/setup-wasm.js`) that automatically copies the required grammar files into `wasm/`.
2. **MongoDB Connectivity**:
   - MongoDB Atlas is connected from Milestone 1 onwards for repository and job metadata.
   - No local JSON fallback for repository metadata.
3. **Resumable Progress Strategy**:
   - Ingestion resume is tracked via chunk content hashing and job offset checkpoints in MongoDB.
   - Chunks use a compound deduplication key: `repoId + filePath + contentHash`.
4. **Model Configuration via `.env.example`**:
   - Model IDs (`EMBEDDING_MODEL_ID`, `LLM_MODEL_ID`) and embedding dimension (`EMBEDDING_DIMENSION`) must come strictly from `.env` and are never hardcoded.
   - The active embedding model name and vector dimension are persisted in repository metadata.
   - Actual model IDs will be supplied by the user.
5. **Evaluation Suite**:
   - Repositories and evaluation question sets in `eval/repos.json` and `eval/questions.json` will be supplied by the user.
6. **Documentation References**:
   - Specification references are standardized to `architecture.md` (lowercase).

---

## 3. Proposed Folder Structure

```
RepoLens/
├── .env.example                  # Environment template (keys, models, limits)
├── .gitignore                    # Excludes .env, node_modules/, temp/, data/
├── AGENTS.md                     # Agent guardrails and project rules
├── architecture.md               # Master technical specification
├── PLAN.md                       # Implementation roadmap and milestones
├── package.json                  # Node.js project definition (ES modules, scripts)
├── wasm/                         # Precompiled web-tree-sitter grammar files (*.wasm)
├── src/
│   ├── config/
│   │   ├── env.js                # Environment variable loader & validator
│   │   └── constants.js          # Ingestion caps, rate caps, regex patterns
│   ├── adapters/
│   │   ├── github.js             # Zipball download, commit SHA, file diff comparison
│   │   ├── embedder.js           # Rate-capped, jittered backoff, batching embedder client
│   │   ├── llm.js                # Swappable LLM adapter (generate, generateStream)
│   │   └── vectorStore.js        # LanceDB hybrid store (vector + BM25 FTS, upsert, delete)
│   ├── ingestion/
│   │   ├── parseRepoUrl.js       # URL validation and {owner, repo} extraction
│   │   ├── fileFilter.js         # Allow/ignore lists, size caps, binary detection
│   │   ├── secretScanner.js      # Heuristic & regex secret/key detector
│   │   ├── chunker.js            # web-tree-sitter (WASM) parser + line fallback
│   │   ├── indexer.js            # Pipeline orchestrator with resumable checkpoints
│   │   └── diffIndexer.js        # Commit-SHA diff incremental indexer
│   ├── retrieval/
│   │   ├── hybridSearch.js       # Vector search + BM25 search + RRF merger
│   │   └── contextBuilder.js     # Token budget, deduplication, tree formatting
│   ├── generation/
│   │   ├── prompts.js            # Grounding, citation format, prompt injection defense
│   │   ├── answer.js             # Pipeline driver: query -> hybrid -> context -> LLM -> citation check
│   │   └── overview.js           # Map-reduce repository overview generator
│   ├── db/
│   │   ├── mongo.js              # MongoDB Atlas connection manager
│   │   └── models.js             # Repositories, ChatSessions, Messages schemas
│   ├── jobs/
│   │   └── runner.js             # In-process queue with MongoDB persistence & restart recovery
│   └── api/
│       ├── server.js             # Express app setup and middleware registration
│       ├── routes/
│       │   ├── repositories.js   # POST /api/repositories, GET /:id, POST /:id/refresh
│       │   └── chat.js           # POST /:id/chat (SSE streaming), GET /:id/sessions/:sessionId
│       ├── controllers/
│       │   ├── repoController.js
│       │   └── chatController.js
│       └── middleware/
│           ├── validation.js     # Payload validation
│           ├── rateLimit.js      # IP/endpoint rate limiting
│           └── errorHandler.js   # Centralized sanitizing error handler
├── scripts/
│   ├── setup-wasm.js             # Copies tree-sitter-wasms into wasm/
│   ├── index-repo.js             # CLI: fetch, filter, chunk, embed, index
│   ├── ask.js                    # CLI: query repo with streaming cited output
│   └── eval.js                   # CLI: benchmark retrieval (Recall@k, MRR)
├── eval/
│   ├── repos.json                # User-supplied pinned repositories and commit SHAs
│   ├── questions.json            # User-supplied benchmark queries with ground-truth expected files
│   └── results.md                # Evaluation metric comparisons (Vector vs BM25 vs Hybrid)
├── tests/
│   ├── unit/                     # Fast unit tests (filter, secrets, chunker, RRF)
│   └── integration/              # Integration tests (adapters, pipelines, endpoints)
└── frontend/                     # React + Vite application (Phase 9)
    ├── index.html
    ├── src/
    │   ├── App.jsx
    │   ├── components/           # IngestionForm, StatusStepper, ChatBox, CitationViewer
    │   └── services/api.js
    └── vite.config.js
```

---

## 4. Milestones and Task Lists

### Milestone 0: Project Foundation & Configuration (Phase 0)
- [x] Initialize `package.json` with `"type": "module"`, configure native test runner (`node --test`).
- [x] Create `.env.example` defining all required configuration variables and free-tier defaults (no hardcoded model IDs).
- [x] Implement `src/config/env.js` and `src/config/constants.js` with validation.
- [x] Establish directory skeleton and write smoke test in `tests/unit/config.test.js`.
- **Acceptance Criteria**: `npm test` executes cleanly and passes; configuration gracefully validates missing or malformed variables.

### Milestone 1: Safe Repository Fetch, Filtering & MongoDB Ingestion (Phase 1)
- [ ] Connect MongoDB Atlas connection lifecycle in `src/db/mongo.js` and repository schema in `src/db/models.js`.
- [ ] Implement `src/ingestion/parseRepoUrl.js` with strict GitHub URL validation and SSRF defenses.
- [ ] Implement `src/adapters/github.js` to get default branch commit SHA and download repository zipball.
- [ ] Implement safe zip extraction (enforce zip-slip protection, max extracted file count, and archive size limits).
- [ ] Implement `src/ingestion/fileFilter.js` (whitelist source extensions, blacklist binaries/minified/lockfiles/vendored dirs).
- [ ] Implement `src/ingestion/secretScanner.js` (detect private keys, `.env*`, API key tokens).
- [ ] Implement CLI entry point `scripts/index-repo.js` (Phases 1 dry run: output file counts, skip reasons, and save repository record to MongoDB).
- [ ] Unit tests for URL parser, zip extraction safety, filter rules, and secret scanner.
- **Acceptance Criteria**: Running `node scripts/index-repo.js <url>` on a public repository downloads the repo safely, lists all included files, flags skipped files, strips simulated secrets, creates/updates MongoDB record with `indexedCommitSha`, and removes temporary archive files.

### Milestone 2: Semantic Chunking with `web-tree-sitter` & WASM (Phase 2)
- [ ] Add `tree-sitter-wasms` (pinned version) and create `scripts/setup-wasm.js` to populate `wasm/`.
- [ ] Setup `web-tree-sitter` runtime and configure grammar loaders for JavaScript, TypeScript, and Python.
- [ ] Implement `src/ingestion/chunker.js`:
  - AST parsing: extract top-level functions, classes, and methods with accurate line ranges and symbols.
  - Markdown chunker: heading-based section chunking.
  - Line-window fallback: sliding window with overlap for unsupported or unparseable files.
- [ ] Format chunk metadata: `filePath`, `language`, `symbol`, `symbolKind`, `startLine`, `endLine`, `content`, `contentHash`.
- [ ] Unit tests testing single-function, multi-function, class, fallback line window, and markdown files.
- **Acceptance Criteria**: A test suite parses sample files in JS, TS, and Python into distinct symbol chunks with accurate line numbers, while unsupported files cleanly fall back without throwing unhandled errors.

### Milestone 3: Resilient Embedder & LanceDB Storage (Phase 3)
- [ ] Implement `src/adapters/embedder.js`:
  - Model IDs and dimensions loaded strictly from env.
  - Batching (e.g., 50 texts per batch).
  - Rate-limiting token bucket / delay to adhere to free-tier RPM/TPM caps.
  - Exponential backoff with random jitter for 429/503 responses.
- [ ] Implement `src/adapters/vectorStore.js` using local embedded LanceDB:
  - Table initialization (`chunks`) with schema including vector and full-text index.
  - Deduplication key: `repoId + filePath + contentHash`.
  - Chunk upsert, deduplication by content hash, and deletion by `repositoryId` or `filePath`.
- [ ] Implement resumable progress: chunk-hash check plus MongoDB offset checkpoint (`statusDetail`).
- [ ] Update `scripts/index-repo.js` to run the full ingestion pipeline to LanceDB.
- **Acceptance Criteria**: Ingesting a repository persists all chunk vectors and text in LanceDB. Rerunning ingestion on the same repository skips already-embedded chunks. Vector query returns relevant chunks.

### Milestone 4: Hybrid Retrieval & Grounded Q&A CLI (Phase 4)
- [ ] Implement `src/retrieval/hybridSearch.js`:
  - Query embedding + LanceDB vector search (top 20).
  - LanceDB BM25 full-text search over `content`, `symbol`, `filePath` (top 20).
  - Reciprocal Rank Fusion (RRF) with constant `k=60` to select top ~8 chunks.
- [ ] Implement `src/retrieval/contextBuilder.js`:
  - Token budget management, chunk deduplication, sorting by file/line, compact file-tree inclusion.
- [ ] Implement `src/adapters/llm.js` (model loaded strictly from env) and strict system prompt in `src/generation/prompts.js`.
- [ ] Implement `src/generation/answer.js` with post-generation citation validation (drop non-retrieved citations).
- [ ] Implement CLI tool `scripts/ask.js <repoId> "question"`.
- **Acceptance Criteria**: Asking "How is authentication handled?" yields a streamed response citing actual file lines; asking an unanswerable question triggers explicit "insufficient context" messaging.

### Milestone 5: Evaluation Harness (MRR & Recall@k) (Phase 5)
- [ ] Ingest user-provided `eval/repos.json` (pinned repositories and commit SHAs) and `eval/questions.json` (queries with ground-truth expected files).
- [ ] Implement `scripts/eval.js`:
  - Index pinned repos if not already indexed.
  - Evaluate questions under 3 modes: Vector-Only, BM25-Only, and Hybrid (Vector + BM25 + RRF).
  - Compute Recall@5, Recall@8, and Mean Reciprocal Rank (MRR).
  - Output results table and append to `eval/results.md`.
- **Acceptance Criteria**: Executing `node scripts/eval.js` benchmarks all configurations automatically, outputs clear comparative metrics proving hybrid retrieval efficacy, and records the results markdown table.

### Milestone 6: Repository Overview Generation (Phase 6)
- [ ] Implement broad vs. specific query classifier in `src/generation/answer.js`.
- [ ] Implement `src/generation/overview.js`:
  - Map step: summarize key directories, entry points, package manifests, and README.
  - Reduce step: synthesize purpose, architecture, key modules, and tech stack.
- [ ] Store structured overview in MongoDB repository record.
- **Acceptance Criteria**: General architectural questions ("What does this repo do?") use the structured overview for instant high-level answers without unnecessary chunk-level noise.

### Milestone 7: Incremental Indexing via Commit SHA (Phase 7)
- [ ] Implement `src/ingestion/diffIndexer.js`:
  - Query GitHub compare API between `indexedCommitSha` and default branch HEAD.
  - Identify added, modified, and deleted files.
  - Safe replacement: insert new chunks before deleting outdated ones.
  - Update `indexedCommitSha` in MongoDB metadata.
- [ ] Add CLI flag `--refresh` to `scripts/index-repo.js`.
- **Acceptance Criteria**: Running refresh on a repo with file diffs only re-embeds changed files, removes deleted file chunks, and keeps retrieval functional throughout the process.

### Milestone 8: Express API, MongoDB Job Queue & Crash Recovery (Phase 8)
- [ ] Implement in-process job queue in `src/jobs/runner.js`:
  - Persist job state changes (`queued`, `fetching`, `processing`, `indexing`, `ready`, `failed`).
  - Crash recovery: on server boot, query MongoDB for in-flight/stalled jobs and auto-resume or mark failed gracefully.
- [ ] Implement Express routes (`/api/repositories`, `/api/repositories/:id`, `/api/repositories/:id/chat`, `/api/repositories/:id/refresh`).
- [ ] Add Server-Sent Events (SSE) for streaming chat answers.
- [ ] Add middleware: IP rate limiting, input validation, centralized error handling.
- **Acceptance Criteria**: Full HTTP lifecycle works via `curl` / API client: trigger ingestion, poll progress, ask questions with streaming SSE responses, and recover cleanly after abrupt process termination.

### Milestone 9: React Frontend (Phase 9)
- [ ] Set up React + Vite project in `frontend/`.
- [ ] Build URL submission form with client-side validation.
- [ ] Build live progress stepper tracking repository indexing states (`fetching` -> `processing` -> `indexing` -> `ready`).
- [ ] Build chat interface with streaming answers, markdown rendering, and clickable citations.
- [ ] Build code inspection drawer: clicking a citation highlights the exact file and line range retrieved.
- **Acceptance Criteria**: A user can submit a repository URL in the browser, monitor real-time ingestion status, and chat with streamed answers and verified citation links.

### Milestone 10: Portfolio Polish & Verification (Phase 10)
- [ ] Produce comprehensive `README.md` with architecture diagram, benchmark table from Phase 5, and setup instructions.
- [ ] Document free-tier hosting strategy and known constraints.
- [ ] Perform end-to-end regression testing across all phases.
- **Acceptance Criteria**: Complete end-to-end flow verified, all tests pass, and documentation is clean and ready for showcase.
