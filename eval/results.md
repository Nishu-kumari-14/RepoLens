# Retrieval Evaluation Benchmark Results

Comparative evaluation of retrieval strategies across benchmark repositories.

## Evaluation Protocol
- **Vector-Only:** Dense embeddings with cosine similarity.
- **BM25-Only:** Full-text BM25 search over code content, symbols, and file paths.
- **Hybrid (RRF):** Reciprocal Rank Fusion ($k=60$) combining Vector and BM25 candidate sets.

## Target Metrics
- **Recall@5:** Ratio of queries where an expected ground-truth file is retrieved within the top 5 results.
- **Recall@8:** Ratio of queries where an expected ground-truth file is retrieved within the top 8 results.
- **MRR (Mean Reciprocal Rank):** Average of the reciprocal rank of the first relevant chunk ($1 / \text{rank}$) across all queries.

## Baseline Results Table

| Retrieval Strategy | Recall@5 | Recall@8 | MRR |
|---|---|---|---|
| Vector-Only | 0.8000 | 1.0000 | 0.7333 |
| BM25-Only | 0.8000 | 1.0000 | 0.7000 |
| **Hybrid (Vector + BM25 + RRF)** | **1.0000** | **1.0000** | **0.9333** |

*Hybrid retrieval achieves the highest MRR and Recall across queries, successfully boosting chunks that match both semantic context and exact code symbol identifiers.*
