package eu.infolead.llmhp.cache;

import java.io.*;
import java.nio.file.*;

final class SemanticCacheCli {

    private final CacheStore store;
    private final InvalidationEngine invalidation;

    SemanticCacheCli(Path cacheDir) {
        this.store = new CacheStore(cacheDir);
        this.invalidation = new InvalidationEngine(cacheDir);
    }

    void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: SemanticCacheCli <lookup|store|invalidate|invalidate-all|stats|invalidate-stale> [args...]");
            System.exit(1);
            return;
        }

        switch (args[0]) {
            case "lookup" -> lookup();
            case "store" -> {
                if (args.length < 2) { System.err.println("store requires <prompt>"); System.exit(1); return; }
                store(args[1]);
            }
            case "invalidate" -> {
                if (args.length < 2) { System.err.println("invalidate requires <prompt>"); System.exit(1); return; }
                store.invalidate(args[1]);
            }
            case "invalidate-all" -> store.invalidateAll();
            case "invalidate-stale" -> {
                var maxAge = args.length >= 2 ? Long.parseLong(args[1]) : CacheStore.DEFAULT_TTL_SECONDS;
                var projectRoot = Path.of(".").toRealPath();
                invalidation.invalidateStale(projectRoot, maxAge);
            }
            case "invalidate-files" -> {
                var changed = new java.util.ArrayList<Path>();
                for (int i = 1; i < args.length; i++) changed.add(Path.of(args[i]));
                invalidation.invalidateForFiles(changed);
            }
            case "stats" -> {
                var s = store.stats();
                System.out.println(s.toJson());
            }
            default -> {
                System.err.println("Unknown command: " + args[0]);
                System.exit(1);
            }
        }
    }

    private void lookup() throws Exception {
        var prompt = readStdin();
        var result = store.lookup(prompt);
        if (result.hit()) {
            System.out.println("{\"hit\":true,\"cached_response\":\"%s\"}".formatted(escapeJson(result.response())));
        } else {
            System.out.println("{\"hit\":false}");
        }
    }

    private void store(String prompt) throws Exception {
        var response = readStdin();
        store.store(prompt, response);
        System.out.println("{\"stored\":true}");
    }

    private String readStdin() throws Exception {
        try (var reader = new java.io.BufferedReader(new java.io.InputStreamReader(System.in))) {
            var sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString().strip();
        }
    }

    private String escapeJson(String s) {
        var sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"' -> sb.append("\\\"");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }
}
