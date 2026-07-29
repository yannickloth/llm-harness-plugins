package eu.infolead.llmhp.cache.types;

public record Embedding(float[] vector, int dimension) {
    public Embedding {
        if (vector == null) throw new IllegalArgumentException("vector must not be null");
        if (vector.length != dimension)
            throw new IllegalArgumentException("vector length %d != dimension %d".formatted(vector.length, dimension));
    }

    public float cosineSimilarity(Embedding other) {
        if (dimension != other.dimension)
            throw new IllegalArgumentException("dimension mismatch: %d vs %d".formatted(dimension, other.dimension));
        float dot = 0f, normA = 0f, normB = 0f;
        for (int i = 0; i < dimension; i++) {
            dot += vector[i] * other.vector[i];
            normA += vector[i] * vector[i];
            normB += other.vector[i] * other.vector[i];
        }
        if (normA == 0f || normB == 0f) return 0f;
        return dot / (float) (Math.sqrt(normA) * Math.sqrt(normB));
    }

    public String toSerialized() {
        var sb = new StringBuilder();
        for (int i = 0; i < dimension; i++) {
            if (i > 0) sb.append(',');
            sb.append(vector[i]);
        }
        return sb.toString();
    }

    public static Embedding fromSerialized(String s, int dimension) {
        var parts = s.split(",");
        if (parts.length != dimension)
            throw new IllegalArgumentException("serialized dim %d != expected %d".formatted(parts.length, dimension));
        var vec = new float[dimension];
        for (int i = 0; i < dimension; i++) vec[i] = Float.parseFloat(parts[i]);
        return new Embedding(vec, dimension);
    }
}
