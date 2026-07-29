package eu.infolead.llmhp.cache;

import eu.infolead.llmhp.cache.types.Embedding;

import java.io.*;
import java.nio.file.*;
import java.util.*;

final class Embedder {

    static final int DIMENSION = 384;
    static final int NGRAM_MIN = 2;
    static final int NGRAM_MAX = 4;

    Embedding embed(String text) {
        if (text == null || text.isBlank()) return zeroEmbedding();
        var chars = text.toCharArray();
        var vec = new float[DIMENSION];

        var rng = new Random(42L);
        for (int n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
            for (int i = 0; i <= chars.length - n; i++) {
                rng.setSeed(hashNgram(chars, i, n));
                var bucket = rng.nextInt(DIMENSION);
                vec[bucket] += 1.0f / n;
            }
        }

        var norm = 0f;
        for (int i = 0; i < DIMENSION; i++) norm += vec[i] * vec[i];
        if (norm > 0) {
            var scale = 1.0f / (float) Math.sqrt(norm);
            for (int i = 0; i < DIMENSION; i++) vec[i] *= scale;
        }

        return new Embedding(vec, DIMENSION);
    }

    private long hashNgram(char[] chars, int off, int len) {
        long h = 1125899906842597L;
        for (int i = 0; i < len; i++) {
            h = 31 * h + chars[off + i];
        }
        return h;
    }

    private Embedding zeroEmbedding() {
        return new Embedding(new float[DIMENSION], DIMENSION);
    }
}
