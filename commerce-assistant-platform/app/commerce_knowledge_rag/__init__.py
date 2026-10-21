"""Approved knowledge ingestion, retrieval, and persistence."""

from app.commerce_knowledge_rag.service import (
    DIMENSIONS,
    Chunk,
    Embedder,
    Hit,
    KnowledgeError,
    KnowledgeIndex,
    Retriever,
    Source,
    chunk_pages,
    evidence,
    extract,
    ingest,
    normalize,
    validate_vectors,
)
from app.commerce_knowledge_rag.store import PostgresKnowledgeIndex

__all__ = [
    "DIMENSIONS",
    "Chunk",
    "Embedder",
    "Hit",
    "KnowledgeError",
    "KnowledgeIndex",
    "PostgresKnowledgeIndex",
    "Retriever",
    "Source",
    "chunk_pages",
    "evidence",
    "extract",
    "ingest",
    "normalize",
    "validate_vectors",
]
