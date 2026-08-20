package eu.infolead.llmhp.cache;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.Base64;
import java.util.List;

/**
 * Long-lived JVM backing the semantic-cache plugin.
 *
 * Reads newline-delimited, tab-separated command frames from stdin and writes
 * one response line per request to stdout. Single-threaded, so requests are
 * naturally serialized. Exits on EOF (its parent's stdin pipe closed) or after
 * an idle timeout, which bounds daemon leaks even when the parent dies without
 * closing stdin (e.g. SIGKILL) or wedges while staying alive.
 *
 * Frame (Base64 keeps arbitrary prompt/response/path bytes out of the protocol):
 *   lookup<TAB><b64 prompt>
 *   store<TAB><b64 prompt><TAB><b64 response>[<TAB>auto|manual|fileop]
 *   invalidate-files<TAB><b64 path>
 *   invalidate-stale
 *   stats
 *   quit
 *
 * Response: "OK<TAB><json>" or "ERR<TAB><message>".
 */
final class SemanticCacheDaemon {

    static final long DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000L;

    private final CacheStore store;
    private final InvalidationEngine invalidation;
    private final long idleTimeoutMs;
    private volatile long lastActivity;
    private volatile boolean processing;

    SemanticCacheDaemon(Path cacheDir, long idleTimeoutMs) {
        this.store = new CacheStore(cacheDir);
        this.invalidation = new InvalidationEngine(cacheDir);
        this.idleTimeoutMs = idleTimeoutMs;
        this.lastActivity = System.currentTimeMillis();
    }

    public static void main(String[] args) throws Exception {
        var cacheDir = args.length > 0 ? Path.of(args[0]) : Path.of(".agentmem", "cache");
        var idleTimeoutMs = args.length > 1 ? Long.parseLong(args[1]) : DEFAULT_IDLE_TIMEOUT_MS;
        new SemanticCacheDaemon(cacheDir, idleTimeoutMs).run();
    }

    void run() throws Exception {
        var stdin = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        var stdout = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);

        if (idleTimeoutMs > 0) {
            Thread.ofVirtual().name("semantic-cache-idle").start(this::watchdog);
        }

        String line;
        while ((line = stdin.readLine()) != null) {
            if (line.isBlank()) continue;
            lastActivity = System.currentTimeMillis();
            processing = true;
            try {
                var op = line.strip().split("\t", -1)[0];
                stdout.println(handle(line.strip()));
                if (op.equals("quit")) return;
            } catch (Exception e) {
                stdout.println("ERR\t" + e.getMessage());
            } finally {
                processing = false;
            }
        }
    }

    /**
     * Bounds leaks: exit if no request arrives within the idle window. Never
     * exits while a request is being handled (a long-running handle is itself
     * activity). Checks every interval, so an idle-exit latches within ~2x the
     * window of the last request regardless of how the parent died or wedged.
     */
    private void watchdog() {
        while (true) {
            try {
                Thread.sleep(idleTimeoutMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            var idleFor = System.currentTimeMillis() - lastActivity;
            if (!processing && idleFor >= idleTimeoutMs) {
                System.exit(0);
            }
        }
    }

    private String handle(String frame) throws Exception {
        var parts = frame.split("\t", -1);
        var op = parts[0];
        switch (op) {
            case "lookup" -> {
                var prompt = b64(parts, 1);
                var result = store.lookup(prompt);
                if (result.hit()) {
                    return "OK\t{\"hit\":true,\"cached_response\":\"%s\"}".formatted(CacheStore.escapeJson(result.response()));
                }
                return "OK\t{\"hit\":false}";
            }
            case "store" -> {
                var prompt = b64(parts, 1);
                var response = b64(parts, 2);
                var source = parts.length > 3 ? parts[3] : StatsStore.SOURCE_MANUAL;
                store.store(prompt, response, source);
                return "OK\t{\"stored\":true}";
            }
            case "invalidate-files" -> {
                var path = b64(parts, 1);
                invalidation.invalidateForFiles(List.of(Path.of(path)));
                return "OK\t{\"invalidated\":true}";
            }
            case "invalidate-stale" -> {
                invalidation.invalidateStale(Path.of(".").toRealPath(), CacheStore.DEFAULT_TTL_SECONDS);
                return "OK\t{\"purged\":true}";
            }
            case "stats" -> {
                return "OK\t" + store.statsJson();
            }
            case "quit" -> {
                return "OK\t{\"bye\":true}";
            }
            default -> throw new IllegalArgumentException("Unknown daemon command: " + op);
        }
    }

    private static String b64(String[] parts, int index) {
        if (index >= parts.length || parts[index].isEmpty()) return "";
        return new String(Base64.getDecoder().decode(parts[index]), StandardCharsets.UTF_8);
    }
}
