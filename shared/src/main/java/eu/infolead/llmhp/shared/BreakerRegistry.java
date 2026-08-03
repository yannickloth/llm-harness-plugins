package eu.infolead.llmhp.shared;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * Registry for managing multiple named circuit breakers within a plugin.
 *
 * <p>Provides centralized load/save/query for all breakers scoped to a
 * persistence directory. Thread-safe for concurrent access.
 */
public final class BreakerRegistry<Ctx> {
    private final Path persistDir;
    private final Map<String, CircuitBreaker<Ctx>> breakers = new ConcurrentHashMap<>();
    private final Map<String, IronGate> gates = new ConcurrentHashMap<>();

    public BreakerRegistry(Path persistDir) {
        this.persistDir = persistDir;
        try { Files.createDirectories(persistDir); } catch (java.io.IOException ignored) {}
    }

    public CircuitBreaker<Ctx> breaker(String name, int consecutiveMax, int totalMax,
                                 Function<Ctx, Ctx> onTrip, Function<Ctx, Ctx> onReset) {
        return breakers.computeIfAbsent(name,
            k -> CircuitBreaker.loadOrFresh(persistDir, k, consecutiveMax, totalMax, onTrip, onReset));
    }

    public CircuitBreaker<Ctx> breaker(String name, int consecutiveMax, int totalMax,
                                 Function<Ctx, Ctx> onTrip) {
        return breaker(name, consecutiveMax, totalMax, onTrip, Function.identity());
    }

    public IronGate gate(String name, Path configPath, boolean defaultClosed) {
        return gates.computeIfAbsent(name, k -> new IronGate(configPath, defaultClosed, 1800));
    }

    public IronGate gate(String name, boolean defaultClosed) {
        return gates.computeIfAbsent(name, k -> new IronGate(defaultClosed));
    }

    public void save(String name) throws java.io.IOException {
        var b = breakers.get(name);
        if (b != null) b.save(persistDir);
    }

    public void saveAll() throws java.io.IOException {
        for (var b : breakers.values()) b.save(persistDir);
    }

    public void reset(String name, long cooldownMs) {
        var b = breakers.get(name);
        if (b != null) b.reset(cooldownMs);
    }

    public void reset(String name) {
        var b = breakers.get(name);
        if (b != null) b.reset();
    }

    public CircuitBreaker<Ctx> get(String name) { return breakers.get(name); }

    public IronGate ironGate(String name) { return gates.get(name); }
}
