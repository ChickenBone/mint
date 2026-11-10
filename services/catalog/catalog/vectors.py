import threading
from functools import lru_cache

from qdrant_client import QdrantClient, models

from catalog.config import Settings
from catalog.model import DIMENSIONS, MODEL, point_id


class Embeddings:
    def __init__(self, cache: str, *, threads: int = 2):
        from fastembed import TextEmbedding

        self.model = TextEmbedding(MODEL, cache_dir=cache, threads=threads)
        self.lock = threading.Lock()

    def documents(self, documents: list[str]) -> list[list[float]]:
        with self.lock:
            return [
                vector.tolist()
                for vector in self.model.embed(documents, batch_size=max(1, len(documents)))
            ]

    @lru_cache(maxsize=256)
    def query(self, query: str) -> tuple[float, ...]:
        return tuple(self.documents([query])[0])


class Vectors:
    def __init__(self, settings: Settings, client: QdrantClient | None = None):
        self.client = client or QdrantClient(url=settings.qdrant_url, timeout=15)
        self.collection = settings.collection

    def close(self):
        self.client.close()

    def initialize(self):
        if not self.client.collection_exists(self.collection):
            self.client.create_collection(
                self.collection,
                vectors_config=models.VectorParams(
                    size=DIMENSIONS, distance=models.Distance.COSINE, on_disk=True
                ),
                hnsw_config=models.HnswConfigDiff(on_disk=True),
                quantization_config=models.ScalarQuantization(
                    scalar=models.ScalarQuantizationConfig(
                        type=models.ScalarType.INT8, quantile=0.99, always_ram=False
                    )
                ),
                on_disk_payload=True,
            )
        self.check()
        for field in ("country", "source", "kind"):
            self.client.create_payload_index(
                self.collection, field, models.PayloadSchemaType.KEYWORD, wait=True
            )

    def check(self):
        config = self.client.get_collection(self.collection).config.params.vectors
        if not isinstance(config, models.VectorParams) or (
            config.size != DIMENSIONS or config.distance != models.Distance.COSINE
        ):
            raise ValueError("Vector collection is incompatible with the fixed embedding model")

    def upsert(self, rows: list[dict], embeddings: list[list[float]]):
        self.client.upsert(
            self.collection,
            points=[
                models.PointStruct(
                    id=point_id(row["key"]),
                    vector=embedding,
                    payload={
                        field: row[field]
                        for field in ("key", "revision", "source", "country", "kind")
                    },
                )
                for row, embedding in zip(rows, embeddings, strict=True)
            ],
            wait=True,
        )

    def search(self, embedding, filters: dict[str, str], limit: int) -> list[dict]:
        response = self.client.query_points(
            self.collection,
            query=list(embedding),
            limit=limit,
            with_payload=True,
            with_vectors=False,
            query_filter=models.Filter(
                must=[
                    models.FieldCondition(key=field, match=models.MatchValue(value=value))
                    for field, value in filters.items()
                ]
            ),
            search_params=models.SearchParams(
                quantization=models.QuantizationSearchParams(rescore=True, oversampling=2)
            ),
        )
        return [point.payload for point in response.points if point.payload]

    def delete_source(self, source: str) -> int:
        if not self.client.collection_exists(self.collection):
            return 0
        query_filter = models.Filter(
            must=[models.FieldCondition(key="source", match=models.MatchValue(value=source))]
        )
        count = self.client.count(self.collection, count_filter=query_filter, exact=True).count
        if count:
            self.client.delete(
                self.collection,
                points_selector=models.FilterSelector(filter=query_filter),
                wait=True,
            )
        return count
