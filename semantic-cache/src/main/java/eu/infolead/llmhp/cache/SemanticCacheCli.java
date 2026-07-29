package eu.infolead.llmhp.cache;

import java.io.*;
import java.nio.file.*;

final class SemanticCacheCli {

    private CacheStore store;
    private InvalidationEngine invalidation;

    SemanticCacheCli() {}
    SemanticCacheCli(Path cacheDir) {
        this.store = new CacheStore(cacheDir);
        this.invalidation = new InvalidationEngine(cacheDir);
    }

    void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: SemanticCacheCli <lookup|store|invalidate|invalidate-all|stats|invalidate-stale|invalidate-files> [--cache-dir <dir>] [args...]");
            System.exit(1);
            return;
        }

        var cacheDir = parseCacheDir(args);

        var cmdIndex = 0;
        var cmd = args[0];

        var offset = 1;
        if (args.length > 1 && args[1].equals("--cache-dir")) offset = 3;

        this.store = new CacheStore(cacheDir);
        this.invalidation = new InvalidationEngine(cacheDir);

        switch (cmd) {
            case "lookup" -> lookup();
            case "store" -> {
                if (args.length < offset + 1) { System.err.println("store requires <prompt>"); System.exit(1); return; }
                store(args[offset]);
            }
            case "invalidate" -> {
                if (args.length < offset + 1) { System.err.println("invalidate requires <prompt>"); System.exit(1); return; }
                store.invalidate(args[offset]);
            }
            case "invalidate-all" -> store.invalidateAll();
            case "invalidate-stale" -> {
                var maxAge = args.length >= offset + 1 ? Long.parseLong(args[offset]) : CacheStore.DEFAULT_TTL_SECONDS;
                var projectRoot = Path.of(".").toRealPath();
                invalidation.invalidateStale(projectRoot, maxAge);
            }
            case "invalidate-files" -> {
                var changed = new java.util.ArrayList<Path>();
                for (int i = offset; i < args.length; i++) changed.add(Path.of(args[i]));
                invalidation.invalidateForFiles(changed);
            }
            case "stats" -> {
                var s = store.stats();
                System.out.println(s.toJson());
            }
            default -> {
                System.err.println("Unknown command: " + cmd);
                System.exit(1);
            }
        }
    }

    private static Path parseCacheDir(String[] args) {
        for (int i = 1; i < args.length - 1; i++) {
            if (args[i].equals("--cache-dir")) return Path.of(args[i + 1]);
        }
        return Path.of(".agentmem", "cache");
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
