package eu.infolead.llmhp.shared;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.function.Function;

/**
 * Iron-gate config for classifier unavailability. Mirrors Claude Code's
 * {@code tengu_iron_gate_closed} GrowthBook feature flag.
 *
 * <p>When closed: fail-closed (classifier unavailable → block/deny).
 * When open: fail-open (classifier unavailable → allow/fallback).
 *
 * <p>Config refreshed from file every 30 minutes (default). File format:
 * <pre>{@code {"closed": true, "refreshIntervalSecs": 1800}}</pre>
 */
public final class IronGate {
    private final Path configPath;
    private final boolean defaultClosed;
    private final int refreshIntervalSecs;
    private volatile boolean closed;
    private volatile Instant lastRefresh;
    private volatile long fileMtime;

    public IronGate(Path configPath, boolean defaultClosed, int refreshIntervalSecs) {
        this.configPath = configPath;
        this.defaultClosed = defaultClosed;
        this.refreshIntervalSecs = refreshIntervalSecs;
        this.closed = defaultClosed;
        this.lastRefresh = Instant.EPOCH;
        this.fileMtime = 0;
    }

    public IronGate(Path configPath) {
        this(configPath, true, 1800);
    }

    public IronGate(boolean defaultClosed) {
        this(null, defaultClosed, 1800);
    }

    public boolean isClosed() {
        refreshIfNeeded();
        return closed;
    }

    public boolean isOpen() { return !isClosed(); }

    private void refreshIfNeeded() {
        if (configPath == null) return;
        if (Instant.now().isBefore(lastRefresh.plusSeconds(refreshIntervalSecs))) return;

        try {
            if (!Files.exists(configPath)) {
                closed = defaultClosed;
                lastRefresh = Instant.now();
                return;
            }
            var mtime = Files.getLastModifiedTime(configPath).toMillis();
            if (mtime == fileMtime && lastRefresh != Instant.EPOCH) return;
            fileMtime = mtime;
            lastRefresh = Instant.now();

            var raw = Files.readString(configPath).strip();
            closed = parseClosed(raw);
        } catch (Exception e) {
            closed = defaultClosed;
        }
    }

    private boolean parseClosed(String json) {
        if (!json.startsWith("{") || !json.endsWith("}")) return defaultClosed;
        var inner = json.substring(1, json.length() - 1);
        for (var pair : inner.split(",")) {
            var kv = pair.split(":", 2);
            if (kv.length < 2) continue;
            var key = kv[0].strip().replace("\"", "");
            if ("closed".equals(key)) {
                return Boolean.parseBoolean(kv[1].strip().replace("\"", "").strip());
            }
        }
        return defaultClosed;
    }

    /**
     * Gate a context through the iron gate. When closed (fail-closed),
     * applies the onClosed transform. When open (fail-open), returns context unchanged.
     */
    public <Ctx> Ctx gate(Ctx ctx, Function<Ctx, Ctx> onClosed) {
        return isClosed() ? onClosed.apply(ctx) : ctx;
    }

    public <Ctx> Ctx gateOpen(Ctx ctx, Function<Ctx, Ctx> onOpen) {
        return isOpen() ? onOpen.apply(ctx) : ctx;
    }
}
