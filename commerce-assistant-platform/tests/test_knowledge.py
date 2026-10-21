import asyncio
import io
import json
import zipfile
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.commerce_action_engine.adapters.runtime_knowledge import RuntimeKnowledge
from app.commerce_action_engine.execution.agents import (
    Agent,
    AgentCatalog,
    KnowledgePolicy,
    ModelConfig,
    Principal,
)
from app.commerce_knowledge_rag import (
    DIMENSIONS,
    Chunk,
    Hit,
    KnowledgeError,
    Retriever,
    Source,
    chunk_pages,
    extract,
    ingest,
    validate_vectors,
)
from app.commerce_resolution_engine.contracts import (
    ModelError,
    ModelEvent,
    ModelResponse,
    Usage,
)
from app.commerce_resolution_engine.providers.embeddings import OpenAIEmbeddings
from app.commerce_resolution_engine.runtime import AgentRuntime

TENANT = UUID(int=1)
WHO = Principal(tenant=TENANT, persona="shopper")
WRITER = Principal(
    tenant=TENANT,
    persona="merchant",
    subject=UUID(int=2),
    permissions=frozenset({"knowledge.write"}),
)
SOURCE = Source(
    id=UUID(int=3),
    tenant=TENANT,
    title="Returns policy",
    revision=1,
    kind="policy",
    effective_from="2020-01-01T00:00:00Z",
    valid_until="2099-01-01T00:00:00Z",
    collection="policies",
    approved=True,
    approved_by=WRITER.subject,
)
AGENT = Agent(
    id="shopper",
    tenant=TENANT,
    persona="shopper",
    model=ModelConfig(profile="test"),
    knowledge=KnowledgePolicy(sources=frozenset({"policies"})),
)
VECTOR = [1.0] + [0.0] * (DIMENSIONS - 1)


class Embeddings:
    model = "test-embeddings"
    calls = 0

    async def embed(self, texts):
        self.calls += 1
        return [VECTOR[:] for _ in texts]

    async def aclose(self):
        pass


class Index:
    def __init__(self, hits=()):
        self.hits = list(hits)
        self.writes = []
        self.cached = False

    async def unchanged(self, *args):
        return self.cached

    async def replace(self, *args):
        self.writes.append(args)
        return True

    async def search(self, *args):
        return self.hits


def hit(text="Return within 30 days.", score=0.9, source=SOURCE):
    return Hit(source, Chunk(str(hash(text)), 1, 0, text), score)


def test_normalization_chunk_bounds_overlap_and_dedup():
    pages = extract(b"\xef\xbb\xbfReturns\r\n\r\n  Within   30 days.  ", "text/plain")
    assert pages == [(1, "Returns\n\nWithin 30 days.")]
    chunks = chunk_pages([(1, "word " * 600), (2, "word " * 600)])
    assert all(0 < len(c.text) <= 1200 for c in chunks)
    assert len({c.id for c in chunks}) == len(chunks)
    assert chunks[0].page == 1


def pdf_bytes():
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/F1"): writer._add_object(font)}
            )
        }
    )
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 20 250 Td (Returns within 30 days.) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_pdf_and_docx_extraction():
    assert "Returns within 30 days." in extract(pdf_bytes(), "application/pdf")[0][1]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Size guide</w:t></w:r></w:p></w:document>',
        )
    assert extract(
        buffer.getvalue(),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) == [(1, "Size guide")]


@pytest.mark.parametrize(
    "data,media",
    [
        (b"x", "text/html"),
        (b"%PDF broken", "application/pdf"),
        (b"\xff", "text/plain"),
        (b"", "text/plain"),
        (b"x" * 5_000_001, "text/plain"),
    ],
)
def test_invalid_or_oversized_input_fails_closed(data, media):
    with pytest.raises(KnowledgeError):
        extract(data, media)


def test_scanned_pdf_requires_ocr():
    writer = PdfWriter()
    writer.add_blank_page(width=10, height=10)
    buffer = io.BytesIO()
    writer.write(buffer)
    with pytest.raises(KnowledgeError, match="ocr_required"):
        extract(buffer.getvalue(), "application/pdf")


def test_approval_and_transactional_kinds_denied():
    with pytest.raises(ValidationError):
        Source(**{**SOURCE.model_dump(), "kind": "catalog"})

    async def scenario():
        for source, actor in [
            (SOURCE, WHO),
            (SOURCE.model_copy(update={"approved": False}), WRITER),
            (SOURCE.model_copy(update={"tenant": UUID(int=999)}), WRITER),
        ]:
            e = Embeddings()
            index = Index()
            with pytest.raises(KnowledgeError, match="approval_required"):
                await ingest(source, b"Policy", "text/plain", actor, e, index)
            assert not e.calls and not index.writes

    asyncio.run(scenario())


def test_ingestion_pipeline_and_provider_failure_preserves_index():
    class Broken(Embeddings):
        async def embed(self, texts):
            raise ModelError("unavailable")

    async def scenario():
        index = Index()
        assert await ingest(
            SOURCE,
            b"Returns within 30 days.",
            "text/plain",
            WRITER,
            Embeddings(),
            index,
        )
        source, digest, chunks, vectors, model = index.writes[0]
        assert source.id == SOURCE.id and source.approved_by == WRITER.subject
        assert len(digest) == 64 and model == "test-embeddings"
        assert chunks[0].page == 1 and vectors == [VECTOR]
        with pytest.raises(ModelError):
            await ingest(
                SOURCE, b"Changed policy", "text/plain", WRITER, Broken(), index
            )
        assert len(index.writes) == 1

    asyncio.run(scenario())


def test_identical_approved_source_reuses_existing_embeddings():
    async def scenario():
        index = Index()
        index.cached = True
        embedder = Embeddings()
        assert not await ingest(
            SOURCE,
            b"Returns within 30 days.",
            "text/plain",
            WRITER,
            embedder,
            index,
        )
        assert embedder.calls == 0
        assert not index.writes

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "vector",
    [
        [0.0] * DIMENSIONS,
        [1.0],
        [float("nan")] * DIMENSIONS,
        [float("inf")] * DIMENSIONS,
        [True] * DIMENSIONS,
        ["1"] * DIMENSIONS,
    ],
)
def test_invalid_embedding_vectors(vector):
    from app.commerce_contracts.embeddings import InvalidVectors
    from app.commerce_contracts.embeddings import validate_vectors as validate_contract

    with pytest.raises(InvalidVectors, match="invalid_embeddings"):
        validate_contract([vector], 1)
    with pytest.raises(KnowledgeError, match="invalid_embeddings"):
        validate_vectors([vector], 1)

    async def scenario():
        embedder = OpenAIEmbeddings(
            model="model",
            api_key="key",
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    content=json.dumps({"data": [{"index": 0, "embedding": vector}]}),
                )
            ),
        )
        try:
            with pytest.raises(ModelError, match="invalid_response"):
                await embedder.embed(["question"])
        finally:
            await embedder.aclose()

    asyncio.run(scenario())


def test_retrieval_filters_threshold_dedup_and_budget():
    async def scenario():
        valid = hit()
        candidates = [
            valid,
            valid,
            hit("Low relevance", 0.1),
            hit(
                "Wrong tenant", source=SOURCE.model_copy(update={"tenant": UUID(int=9)})
            ),
            hit("Unapproved", source=SOURCE.model_copy(update={"approved": False})),
            hit(
                "Merchant only",
                source=SOURCE.model_copy(update={"personas": frozenset({"merchant"})}),
            ),
            hit(
                "Private",
                source=SOURCE.model_copy(update={"permissions": frozenset({"secret"})}),
            ),
            hit("Foreign", source=SOURCE.model_copy(update={"language": "fr"})),
            hit(
                "Wrong collection",
                source=SOURCE.model_copy(update={"collection": "other"}),
            ),
            hit("x" * 1200, 1.0),
        ]
        a = AGENT.model_copy(
            update={
                "knowledge": KnowledgePolicy(
                    sources=frozenset({"policies"}), max_characters=500
                )
            }
        )
        hits = await Retriever(Embeddings(), Index(candidates)).retrieve(
            a, WHO, "Return a purchase", language="en", kinds=frozenset({"policy"})
        )
        assert hits == (valid,)

    asyncio.run(scenario())


def test_runtime_context_provenance_and_retrieval_outage():
    class Model:
        def __init__(self):
            self.requests = []

        async def stream(self, request):
            self.requests.append(request)
            yield ModelEvent("text_delta", "See Returns policy, page 1.")
            yield ModelEvent(
                "completed",
                response=ModelResponse(
                    "See Returns policy, page 1.",
                    (),
                    None,
                    Usage(1, 1, 2),
                    "test",
                    "stop",
                ),
            )

    class Broken(Retriever):
        async def retrieve(self, *args):
            raise ModelError("unavailable")

    async def scenario():
        for retriever in [
            Retriever(Embeddings(), Index([hit()])),
            Broken(Embeddings(), Index()),
        ]:
            model = Model()
            runtime = AgentRuntime(
                AgentCatalog((AGENT,)),
                {"test": model},
                retriever=RuntimeKnowledge(retriever),
            )
            events = [
                e
                async for e in runtime.stream(
                    agent_id="shopper", principal=WHO, message="Return a purchase"
                )
            ]
            request = model.requests[-1]
            assert "Return within 30 days" not in request.instructions
            if isinstance(retriever, Broken):
                assert not events[-1].answer.sources
            else:
                data = json.loads(request.messages[0].text)
                assert data["untrusted_knowledge"][0]["provenance"]["revision"] == 1
                assert str(SOURCE.id) in events[-1].answer.sources[0]

    asyncio.run(scenario())


def test_embeddings_adapter_orders_and_validates_response():
    async def scenario():
        def handle(request):
            assert request.url.path == "/v1/embeddings"
            assert json.loads(request.content)["dimensions"] == DIMENSIONS
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": 1, "embedding": VECTOR},
                        {"index": 0, "embedding": VECTOR},
                    ]
                },
            )

        e = OpenAIEmbeddings(
            model="configured-embedding-model",
            api_key="test",
            transport=httpx.MockTransport(handle),
        )
        try:
            assert await e.embed(["a", "b"]) == [VECTOR, VECTOR]
        finally:
            await e.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "response,code",
    [
        (httpx.Response(429), "rate_limit"),
        (httpx.Response(500), "unavailable"),
        (
            httpx.Response(200, json={"data": [{"index": 0, "embedding": [1]}]}),
            "invalid_response",
        ),
    ],
)
def test_embedding_adapter_failures(response, code):
    async def scenario():
        e = OpenAIEmbeddings(
            model="model",
            api_key="key",
            transport=httpx.MockTransport(lambda _: response),
        )
        try:
            with pytest.raises(ModelError, match=code):
                await e.embed(["question"])
        finally:
            await e.aclose()

    asyncio.run(scenario())
