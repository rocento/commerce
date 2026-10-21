"""Approved unstructured knowledge: extraction, chunking, embedding and retrieval."""

import asyncio
import hashlib
import io
import json
import math
import re
import sys
import unicodedata
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol
from urllib.parse import urlsplit
from uuid import UUID
from xml.etree import ElementTree

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
from pypdf import PdfReader

from app.commerce_contracts.agents import Agent, Principal
from app.commerce_contracts.embeddings import DIMENSIONS, InvalidVectors
from app.commerce_contracts.embeddings import (
    validate_vectors as validate_embedding_vectors,
)
from app.commerce_knowledge_rag.policy_review import policy_identity

__all__ = [
    "DIMENSIONS",
    "Chunk",
    "Embedder",
    "Hit",
    "KnowledgeError",
    "KnowledgeIndex",
    "Retriever",
    "Source",
    "chunk_pages",
    "evidence",
    "extract",
    "ingest",
    "normalize",
    "validate_vectors",
]


class KnowledgeError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(f"Knowledge unavailable: {code}")


class Source(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: UUID
    tenant: UUID
    title: str = Field(min_length=1, max_length=200)
    revision: int = Field(ge=1)
    kind: Literal["faq", "policy", "size_guide", "buying_guide", "imported"]
    language: str = Field(default="en", min_length=2, max_length=20)
    collection: str = Field(min_length=1, max_length=100)
    approved: bool = False
    approved_by: UUID | None = None
    personas: frozenset[Literal["shopper", "merchant"]] = frozenset({"shopper"})
    permissions: frozenset[str] = frozenset()
    origin: str = Field(default="", max_length=500)
    effective_from: AwareDatetime | None = None
    valid_until: AwareDatetime | None = None
    withdrawn_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def validity(self) -> "Source":
        if (self.effective_from is None) != (self.valid_until is None):
            raise ValueError("Both policy effective dates are required")
        if (
            self.effective_from is not None
            and self.valid_until is not None
            and self.valid_until <= self.effective_from
        ):
            raise ValueError("Policy expiry must follow its effective date")
        return self

    def current(self, now: datetime | None = None) -> bool:
        now = now or datetime.now(UTC)
        if not self.approved or (self.withdrawn_at and self.withdrawn_at <= now):
            return False
        if self.effective_from is None:
            return self.kind != "policy"
        return (
            self.valid_until is not None
            and self.effective_from <= now < self.valid_until
        )

    @field_validator("origin")
    @classmethod
    def safe_origin(cls, value: str) -> str:
        if value:
            url = urlsplit(value)
            if (
                url.scheme != "https"
                or not url.hostname
                or url.username
                or url.password
            ):
                raise ValueError(
                    "Source origin must be an HTTPS reference without credentials"
                )
        return value


@dataclass(frozen=True)
class Chunk:
    id: str
    page: int
    ordinal: int
    text: str


@dataclass(frozen=True)
class Hit:
    source: Source
    chunk: Chunk
    score: float


class Embedder(Protocol):
    model: str

    async def embed(self, texts: list[str]) -> list[list[float]]: ...

    async def aclose(self) -> None: ...


class KnowledgeIndex(Protocol):
    async def unchanged(self, source: Source, digest: str, model: str) -> bool: ...

    async def replace(
        self,
        source: Source,
        digest: str,
        chunks: list[Chunk],
        vectors: list[list[float]],
        model: str,
    ) -> bool: ...

    async def search(
        self,
        principal: Principal,
        collections: frozenset[str],
        vector: list[float],
        model: str,
        language: str | None,
        kinds: frozenset[str],
    ) -> list[Hit]: ...


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text).replace("\x00", "")
    return "\n".join(
        re.sub(r"[^\S\n]+", " ", line).strip() for line in text.splitlines()
    ).strip()


def extract(data: bytes, media_type: str) -> list[tuple[int, str]]:
    if not data or len(data) > 5_000_000:
        raise KnowledgeError("file_limit")
    try:
        if media_type in ("text/plain", "text/markdown"):
            pages = [(1, data.decode("utf-8-sig"))]
        elif media_type == "application/pdf":
            reader = PdfReader(io.BytesIO(data), strict=True)
            if reader.is_encrypted or len(reader.pages) > 100:
                raise KnowledgeError("pdf_limit")
            pages = []
            for index, page in enumerate(reader.pages):
                content = page.get_contents()
                if content is not None and len(content.get_data()) > 5_000_000:
                    raise KnowledgeError("pdf_limit")
                pages.append((index + 1, page.extract_text() or ""))
        elif (
            media_type
            == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entry = archive.getinfo("word/document.xml")
                if entry.file_size > 2_000_000:
                    raise KnowledgeError("document_limit")
                xml = archive.read(entry)
                if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
                    raise KnowledgeError("invalid_document")
                root = ElementTree.fromstring(xml)
                ns = {
                    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                }
                paragraphs = ["".join(p.itertext()) for p in root.findall(".//w:p", ns)]
                pages = [(1, "\n\n".join(paragraphs))]
        else:
            raise KnowledgeError("unsupported_format")
        pages = [(page, normalize(text)) for page, text in pages if text.strip()]
        if not pages or sum(len(text) for _, text in pages) > 100_000:
            raise KnowledgeError("text_limit_or_ocr_required")
        return pages
    except KnowledgeError:
        raise
    except Exception:  # noqa: BLE001 -- parser details and document content stay private
        raise KnowledgeError("invalid_document") from None


def chunk_pages(pages: list[tuple[int, str]]) -> list[Chunk]:
    chunks: list[Chunk] = []
    seen: set[str] = set()
    for page, text in pages:
        start = 0
        while start < len(text):
            end = min(start + 1200, len(text))
            if end < len(text):
                boundary = max(
                    text.rfind("\n", start + 600, end),
                    text.rfind(" ", start + 600, end),
                )
                if boundary > start:
                    end = boundary
            body = text[start:end].strip()
            digest = hashlib.sha256(body.encode()).hexdigest()
            if body and digest not in seen:
                seen.add(digest)
                chunks.append(Chunk(digest, page, len(chunks), body))
            if end == len(text):
                break
            start = max(start + 1, end - 100)
    if not chunks or len(chunks) > 128:
        raise KnowledgeError("chunk_limit")
    return chunks


def validate_vectors(vectors: list[list[float]], count: int) -> None:
    try:
        validate_embedding_vectors(vectors, count)
    except InvalidVectors:
        raise KnowledgeError("invalid_embeddings") from None


async def extract_isolated(data: bytes, media_type: str) -> list[tuple[int, str]]:
    if not data or len(data) > 5_000_000:
        raise KnowledgeError("file_limit")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app.knowledge_extract",
        media_type,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with asyncio.timeout(15):
            stdout, _ = await process.communicate(data)
        if process.returncode != 0 or len(stdout) > 1_000_000:
            raise KnowledgeError("extraction_failed")
        return [(int(page), str(text)) for page, text in json.loads(stdout)]
    except TimeoutError:
        raise KnowledgeError("extraction_timeout") from None
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


async def ingest(
    source: Source,
    data: bytes,
    media_type: str,
    principal: Principal,
    embedder: Embedder,
    index: KnowledgeIndex,
) -> bool:
    if (
        principal.tenant != source.tenant
        or principal.persona != "merchant"
        or "knowledge.write" not in principal.permissions
        or not source.current()
    ):
        raise KnowledgeError("approval_required")
    chunks = chunk_pages(await extract_isolated(data, media_type))
    digest = hashlib.sha256(
        json.dumps([(c.page, c.text) for c in chunks]).encode()
    ).hexdigest()
    approved = source.model_copy(update={"approved_by": principal.subject})
    if await index.unchanged(approved, digest, embedder.model):
        return False
    vectors: list[list[float]] = []
    for start in range(0, len(chunks), 16):
        batch = await embedder.embed(
            [chunk.text for chunk in chunks[start : start + 16]]
        )
        validate_vectors(batch, len(chunks[start : start + 16]))
        vectors.extend(batch)
    # Index replacement is atomic; extraction/provider failure leaves previous revision intact.
    return await index.replace(
        approved,
        digest,
        chunks,
        vectors,
        embedder.model,
    )


class Retriever:
    def __init__(self, embedder: Embedder, index: KnowledgeIndex):
        self.embedder = embedder
        self.index = index

    async def retrieve(
        self,
        agent: Agent,
        principal: Principal,
        query: str,
        language: str | None = None,
        kinds: frozenset[str] = frozenset(),
    ) -> tuple[Hit, ...]:
        if agent.tenant != principal.tenant or agent.persona != principal.persona:
            raise KnowledgeError("forbidden")
        if not agent.knowledge.sources or not agent.knowledge.max_documents:
            return ()
        vectors = await self.embedder.embed([query])
        validate_vectors(vectors, 1)
        candidates = await self.index.search(
            principal,
            agent.knowledge.sources,
            vectors[0],
            self.embedder.model,
            language,
            kinds,
        )
        policy_sources: dict[tuple[str, str], set[UUID]] = {}
        for hit in candidates:
            source = hit.source
            if (
                source.kind == "policy"
                and source.current()
                and source.approved_by is not None
                and source.tenant == principal.tenant
                and source.collection in agent.knowledge.sources
                and principal.persona in source.personas
                and source.permissions <= principal.permissions
                and (not language or source.language == language)
                and (not kinds or source.kind in kinds)
            ):
                key = (source.language, policy_identity(source.title))
                policy_sources.setdefault(key, set()).add(source.id)
        if any(len(ids) > 1 for ids in policy_sources.values()):
            raise KnowledgeError("policy_source_conflict")
        selected: list[Hit] = []
        used = 0
        seen: set[str] = set()
        # Semantic score first, then deterministic provenance tie-breakers.
        for hit in sorted(
            candidates, key=lambda h: (-h.score, str(h.source.id), h.chunk.ordinal)
        ):
            s = hit.source
            if (
                not s.current()
                or s.tenant != principal.tenant
                or s.collection not in agent.knowledge.sources
                or principal.persona not in s.personas
                or not s.permissions <= principal.permissions
                or (language and s.language != language)
                or (kinds and s.kind not in kinds)
            ):
                continue
            if not math.isfinite(hit.score) or hit.score < 0.3 or hit.chunk.id in seen:
                continue
            # Budget serialized evidence, including provenance and escaping; skip oversized chunks.
            cost = len(
                json.dumps(
                    {
                        "source": s.collection,
                        "text": hit.chunk.text,
                        "provenance": {
                            key: value
                            for key, value in evidence(hit).items()
                            if key != "text"
                        },
                    }
                )
            )
            if used + cost > agent.knowledge.max_characters:
                continue
            if len(selected) >= agent.knowledge.max_documents:
                break
            selected.append(hit)
            seen.add(hit.chunk.id)
            used += cost
        return tuple(selected)


def evidence(hit: Hit) -> dict[str, object]:
    return {
        "source_id": str(hit.source.id),
        "revision": hit.source.revision,
        "effective_from": hit.source.effective_from.isoformat()
        if hit.source.effective_from
        else None,
        "valid_until": hit.source.valid_until.isoformat()
        if hit.source.valid_until
        else None,
        "title": hit.source.title,
        "kind": hit.source.kind,
        "origin": hit.source.origin,
        "page": hit.chunk.page,
        "chunk_id": hit.chunk.id,
        "text": hit.chunk.text,
    }
