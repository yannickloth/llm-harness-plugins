package eu.infolead.llmhp.offload;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Persistent state for the offload plugin.
 *
 * <p>Two kinds of state, both as JSON files under {@code .premium-read-offload/}:
 *
 * <ul>
 *   <li><b>Active-session model cache</b> ({@code .sessions/<sessionId>.json}) —
 *       the provider/model last seen for a session from {@code chat.message},
 *       because {@code tool.execute.before} carries no model info.</li>
 *   <li><b>Worker sessions</b> ({@code .workers/<corpusHash>.json}) — maps a
 *       corpus fingerprint to a reusable {@code opencode run} session id, so
 *       follow-up questions hit the DeepSeek prefix cache (§5 of the design).</li>
 * </ul>
 *
 * <p>Writes are WAL-atomic: temp file → fsync → ATOMIC_MOVE, the same pattern as
 * {@code tier-router}'s BudgetTracker and {@code agentmem}'s MemoryStore.
 */
public final class WorkerStore {

    private final Path root;
    private final Path sessionsDir;
    private final Path workersDir;
    private final Path permitsDir;
    private final Path metricsFile;

    public WorkerStore(Path projectDir) {
        this.root = projectDir.resolve(".premium-read-offload");
        this.sessionsDir = root.resolve(".sessions");
        this.workersDir = root.resolve(".workers");
        this.permitsDir = root.resolve(".permits");
        this.metricsFile = root.resolve("metrics.jsonl");
    }

    private static void ensure(Path dir) {
        try { Files.createDirectories(dir); }
        catch (IOException e) { throw new UncheckedIOException(e); }
    }

    // ── Active-session model cache ──────────────────────────────────────────

    /** Record the provider/model seen for a session (from chat.message). */
    public void recordSessionModel(String sessionId, String providerID, String modelID) {
        ensure(sessionsDir);
        var json = "{\"providerID\":\"" + safe(sessionIdOr(providerID)) + "\",\"modelID\":\"" + safe(sessionIdOr(modelID)) + "\"}";
        atomicWrite(sessionsDir.resolve(safeFile(sessionId) + ".json"), json);
    }

    /** @return {@code {providerID, modelID}} for the session, or null if unknown. */
    public String[] sessionModel(String sessionId) {
        var f = sessionsDir.resolve(safeFile(sessionId) + ".json");
        if (!Files.isRegularFile(f)) return null;
        try {
            var text = Files.readString(f, StandardCharsets.UTF_8);
            var p = field(text, "providerID");
            var m = field(text, "modelID");
            if (p == null || m == null) return null;
            return new String[]{ p, m };
        } catch (IOException e) {
            return null;
        }
    }

    // ── Worker sessions ─────────────────────────────────────────────────────

    /**
     * Corpus fingerprint → lookup key (a hash of the ordered
     * {@code path:size:mtime} list). Identical corpora hash the same; a content
     * change hashes differently. The hash is only the lookup key — staleness is
     * decided by the stored fingerprint comparison in
     * {@link #workerSession(String, List)}, so a hash collision cannot surface a
     * stale session.
     */
    public static String corpusKey(List<String> fingerprints) {
        var joined = String.join("\n", fingerprints);
        long h = 1125899906842597L;
        for (int i = 0; i < joined.length(); i++) h = 31 * h + joined.charAt(i);
        return Long.toUnsignedString(h, 16);
    }

    /**
     * The joined fingerprint string for a corpus. This is what the record
     * stores so a lookup can <em>verify</em> the corpus has not changed, rather
     * than merely hashing it into a bucket.
     */
    public static String fingerprintString(List<String> fingerprints) {
        return String.join("\n", fingerprints);
    }

    /**
     * @return the worker session id for a corpus, or null. The stored
     *         fingerprint must equal {@code fingerprints} — a corpus whose
     *         content changed has a different fingerprint, so it is a miss even
     *         if its hash collides with another entry's key. This comparison,
     *         not the hash, is what prevents stale sessions from being reused.
     */
    public String workerSession(String corpusKey, List<String> fingerprints) {
        var f = workersDir.resolve(corpusKey + ".json");
        if (!Files.isRegularFile(f)) return null;
        try {
            var text = Files.readString(f, StandardCharsets.UTF_8);
            var stored = field(text, "fingerprint");
            if (fingerprints != null && !fingerprintString(fingerprints).equals(stored)) {
                return null; // corpus changed → stale record
            }
            var id = field(text, "sessionID");
            return (id == null || id.isBlank()) ? null : id;
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * Record/refresh the worker session id for a corpus. Stores the fingerprint
     * alongside the session id and refresh timestamp; a later lookup compares
     * the fingerprint to detect a changed corpus.
     */
    public void setWorkerSession(String corpusKey, String sessionID, List<String> fingerprints, List<Path> paths) {
        ensure(workersDir);
        var sb = new StringBuilder();
        sb.append("{\"sessionID\":\"").append(safe(sessionID)).append("\"");
        sb.append(",\"fingerprint\":\"").append(safe(fingerprintString(fingerprints))).append("\"");
        sb.append(",\"ts\":\"").append(Instant.now().toString()).append("\"");
        sb.append(",\"paths\":[");
        for (int i = 0; i < paths.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append("\"").append(safe(paths.get(i).toString())).append("\"");
        }
        sb.append("]}");
        atomicWrite(workersDir.resolve(corpusKey + ".json"), sb.toString());
    }

    /** @return the epoch-millis timestamp of a worker record, or 0 if unknown. */
    public long workerTimestamp(String corpusKey) {
        var f = workersDir.resolve(corpusKey + ".json");
        if (!Files.isRegularFile(f)) return 0L;
        try {
            var ts = field(Files.readString(f, StandardCharsets.UTF_8), "ts");
            if (ts == null || ts.isBlank()) {
                // Records written before timestamps existed: fall back to mtime.
                return Files.getLastModifiedTime(f).toMillis();
            }
            return Instant.parse(ts).toEpochMilli();
        } catch (Exception e) {
            try { return Files.getLastModifiedTime(f).toMillis(); }
            catch (IOException io) { return 0L; }
        }
    }

    /** All worker record keys currently on disk. */
    public List<String> workerKeys() {
        var out = new ArrayList<String>();
        if (!Files.isDirectory(workersDir)) return out;
        try (var stream = Files.list(workersDir)) {
            for (var f : stream.toList()) {
                var name = f.getFileName().toString();
                if (name.endsWith(".json")) out.add(name.substring(0, name.length() - 5));
            }
        } catch (IOException e) {
            // best-effort
        }
        return out;
    }

    /** Delete a worker record by key. */
    public boolean deleteWorker(String corpusKey) {
        try { return Files.deleteIfExists(workersDir.resolve(corpusKey + ".json")); }
        catch (IOException e) { return false; }
    }

    /** All known worker session ids (for pruning). */
    public List<String> workerSessionIds() {
        var out = new ArrayList<String>();
        if (!Files.isDirectory(workersDir)) return out;
        try (var stream = Files.list(workersDir)) {
            for (var f : stream.toList()) {
                var id = field(Files.readString(f, StandardCharsets.UTF_8), "sessionID");
                if (id != null && !id.isBlank()) out.add(id);
            }
        } catch (IOException e) {
            // best-effort
        }
        return out;
    }

    // ── One-shot direct-read permits ────────────────────────────────────────

    /** Grant a one-shot, path-scoped permission for (session, path). */
    public void grantDirectRead(String sessionId, String path) {
        ensure(permitsDir);
        var key = safeFile(sessionId) + "__" + corpusKey(List.of(path));
        atomicWrite(permitsDir.resolve(key + ".json"), "{\"path\":\"" + safe(path) + "\"}");
    }

    /** Consume a one-shot permission if present. */
    public boolean consumeDirectRead(String sessionId, String path) {
        var key = safeFile(sessionId) + "__" + corpusKey(List.of(path));
        var f = permitsDir.resolve(key + ".json");
        if (!Files.isRegularFile(f)) return false;
        try { Files.delete(f); return true; }
        catch (IOException e) { return false; }
    }

    // ── cost telemetry ──────────────────────────────────────────────────────

    /**
     * Append one telemetry line to {@code metrics.jsonl}. The caller supplies
     * the whole JSON object; the line is validated by the caller (the CLI
     * assembles it from typed fields) and terminated here.
     *
     * <p>Append-only and best-effort: telemetry must never break an offload.
     * A single writer (the plugin shim) appends one line at a time, so no lock
     * is needed; a partial line from a crash is skipped by {@link #readMetrics}.
     */
    public void appendMetric(String json) {
        ensure(root);
        var line = (json == null ? "{}" : json.replace("\n", " ").replace("\r", " ")) + "\n";
        try (var ch = FileChannel.open(metricsFile, StandardOpenOption.CREATE,
                StandardOpenOption.WRITE, StandardOpenOption.APPEND)) {
            ch.write(StandardCharsets.UTF_8.encode(line));
        } catch (IOException e) {
            // best-effort telemetry
        }
    }

    /** All parseable telemetry lines, oldest first. Unparseable lines skipped. */
    public List<String> readMetrics() {
        var out = new ArrayList<String>();
        if (!Files.isRegularFile(metricsFile)) return out;
        try {
            for (var line : Files.readAllLines(metricsFile, StandardCharsets.UTF_8)) {
                var t = line.trim();
                if (!t.isEmpty() && t.startsWith("{")) out.add(t);
            }
        } catch (IOException e) {
            // best-effort
        }
        return out;
    }

    // ── pruning ─────────────────────────────────────────────────────────────

    /**
     * Remove worker records whose timestamp is older than {@code ttl}. Returns
     * the pruned keys.
     *
     * <p>Staleness (corpus changed) is handled at read time by fingerprint
     * comparison in {@link #workerSession}, not here: a stale record is simply
     * never used, so this only needs to bound how long unused records live.
     * A changed corpus therefore does not need an eager sweep to be correct —
     * its old record ages out. A {@code ttl} of zero or less prunes nothing.
     */
    public List<String> pruneWorkers(Duration ttl) {
        var pruned = new ArrayList<String>();
        if (ttl == null || ttl.toMillis() <= 0) return pruned;
        long now = Instant.now().toEpochMilli();
        for (var key : workerKeys()) {
            long ts = workerTimestamp(key);
            if (ts > 0 && now - ts > ttl.toMillis()) {
                if (deleteWorker(key)) pruned.add(key);
            }
        }
        return pruned;
    }

    // ── atomic write ────────────────────────────────────────────────────────

    private static void atomicWrite(Path target, String content) {
        ensure(target.getParent());
        var tmp = target.getParent().resolve(".tmp-" + target.getFileName() + "." + UUID.randomUUID());
        try {
            try (var ch = FileChannel.open(tmp, StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE)) {
                ch.write(StandardCharsets.UTF_8.encode(content));
                ch.force(true);
            }
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailed) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ── JSON helpers ────────────────────────────────────────────────────────

    /** Read a top-level string field from a flat JSON object (no dependency). */
    static String field(String json, String name) {
        if (json == null) return null;
        var key = "\"" + name + "\"";
        int i = json.indexOf(key);
        if (i < 0) return null;
        int colon = json.indexOf(':', i + key.length());
        if (colon < 0) return null;
        int q1 = json.indexOf('"', colon + 1);
        if (q1 < 0) return null;
        var sb = new StringBuilder();
        for (int j = q1 + 1; j < json.length(); j++) {
            char c = json.charAt(j);
            if (c == '\\' && j + 1 < json.length()) {
                // Decode the escapes written by safe(), so a value round-trips
                // exactly (newlines, tabs, backslashes in paths).
                char e = json.charAt(++j);
                switch (e) {
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    default -> sb.append(e); // \" \\ \/ and anything else
                }
                continue;
            }
            if (c == '"') break;
            sb.append(c);
        }
        return sb.toString();
    }

    static String safe(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    private static String safeFile(String s) {
        if (s == null || s.isBlank()) return "unknown";
        return s.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static String sessionIdOr(String v) { return v == null ? "" : v; }

    // ── corpus fingerprints ─────────────────────────────────────────────────

    /** Fingerprint {@code path:size:mtimeMillis} for each path, existing or not. */
    public static List<String> fingerprints(List<Path> paths) {
        var out = new ArrayList<String>();
        for (var p : paths) {
            String size = "?", mtime = "?";
            try {
                if (Files.exists(p)) {
                    size = String.valueOf(Files.size(p));
                    mtime = String.valueOf(Files.getLastModifiedTime(p).toMillis());
                }
            } catch (IOException e) {
                // leave as unknown
            }
            out.add(p.toString() + ":" + size + ":" + mtime);
        }
        return out;
    }

    Map<String, String> snapshot() {
        var m = new LinkedHashMap<String, String>();
        m.put("root", root.toString());
        return m;
    }
}
