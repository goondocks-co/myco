export const VECTOR_INDEX_NAME = 'myco-server-memory';
export const VECTOR_INDEX_DIMENSIONS = 1536;
export const VECTOR_METADATA_FIELDS = ['type', 'status', 'session_id', 'created_at', 'observation_type', 'release_state', 'release_confidence'] as const;

export const VECTOR_BINDINGS = `
[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE"
index_name = "${VECTOR_INDEX_NAME}"
`;
