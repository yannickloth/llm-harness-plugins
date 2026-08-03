import module java.base;

import eu.infolead.llmhp.shared.CircuitBreaker;
import eu.infolead.llmhp.shared.DenialTracker;
import eu.infolead.llmhp.shared.IronGate;
import eu.infolead.llmhp.shared.BreakerRegistry;

/**
 * Tests for CircuitBreaker, DenialTracker, IronGate, and BreakerRegistry.
 * Runs as plain main — the build.sh runner invokes each *Test.class via java --class-path.
 */
void main() throws Exception {
    testFreshState();
    testRecordFailureTrips();
    testRecordSuccessResets();
    testTotalMaxTrips();
    testReset();
    testGateTransform();
    testCooldown();
    testJsonRoundtrip();
    testLoadOrFresh();
    testDenialTracker();
    testDenialAllows();
    testIronGate();
    testBreakerRegistry();

    System.out.println("CircuitBreaker tests: PASSED");
}

void assertTrue(boolean condition, String message) {
    if (!condition) throw new AssertionError("FAIL: " + message);
}

void assertEquals(int expected, int actual, String message) {
    if (expected != actual) throw new AssertionError("FAIL: " + message + " — expected " + expected + ", got " + actual);
}

void assertEquals(long expected, long actual, String message) {
    if (expected != actual) throw new AssertionError("FAIL: " + message + " — expected " + expected + ", got " + actual);
}

void assertEquals(boolean expected, boolean actual, String message) {
    if (expected != actual) throw new AssertionError("FAIL: " + message + " — expected " + expected + ", got " + actual);
}

void assertEquals(String expected, String actual, String message) {
    if (!expected.equals(actual)) throw new AssertionError("FAIL: " + message + " — expected '" + expected + "', got '" + actual + "'");
}

void testFreshState() {
    var breaker = new CircuitBreaker<String>("test-fresh", 3, 10,
        ctx -> ctx + " tripped");
    var s = breaker.state();

    assertTrue(!s.tripped(), "fresh state should not be tripped");
    assertEquals(0, s.consecutiveFailures(), "fresh state consecutive");
    assertEquals(0, s.totalFailures(), "fresh state total");
    assertEquals("test-fresh", s.breakerId(), "breaker ID");

    System.out.println("  [PASS] testFreshState");
}

void testRecordFailureTrips() {
    var breaker = new CircuitBreaker<String>("test-trip", 2, 10,
        ctx -> ctx + " tripped");

    breaker.recordFailure();
    assertTrue(!breaker.isTripped(), "after 1 failure, not tripped");
    assertEquals(1, breaker.state().consecutiveFailures(), "consecutive after 1");

    breaker.recordFailure();
    assertTrue(breaker.isTripped(), "after 2 consecutive failures, tripped");
    assertEquals(2, breaker.state().consecutiveFailures(), "consecutive after 2");
    assertEquals(2, breaker.state().totalFailures(), "total after 2");

    System.out.println("  [PASS] testRecordFailureTrips");
}

void testRecordSuccessResets() {
    var breaker = new CircuitBreaker<String>("test-reset-consecutive", 3, 10,
        ctx -> ctx + " tripped");

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();

    assertEquals(0, breaker.state().consecutiveFailures(), "consecutive after success reset");
    assertEquals(2, breaker.state().totalFailures(), "total after success still counts");
    assertTrue(!breaker.isTripped(), "not tripped after success");

    System.out.println("  [PASS] testRecordSuccessResets");
}

void testTotalMaxTrips() {
    var breaker = new CircuitBreaker<String>("test-total", 5, 3,
        ctx -> ctx + " tripped");

    breaker.recordFailure();
    breaker.recordSuccess();  // reset consecutive
    breaker.recordFailure();
    breaker.recordSuccess();  // reset consecutive
    breaker.recordFailure();  // 3rd total

    assertTrue(breaker.isTripped(), "should trip on total max");
    assertEquals(3, breaker.state().totalFailures(), "total failures");

    System.out.println("  [PASS] testTotalMaxTrips");
}

void testReset() {
    var breaker = new CircuitBreaker<String>("test-reset", 2, 10,
        ctx -> ctx + " tripped");

    breaker.recordFailure();
    breaker.recordFailure();
    assertTrue(breaker.isTripped(), "tripped before reset");

    breaker.reset(0L);
    assertTrue(!breaker.isTripped(), "not tripped after reset");
    assertEquals(0, breaker.state().consecutiveFailures(), "consecutive after reset");
    assertEquals(0, breaker.state().totalFailures(), "total after reset");

    System.out.println("  [PASS] testReset");
}

void testGateTransform() {
    var breaker = new CircuitBreaker<String>("test-gate", 1, 10,
        (String ctx) -> ctx.toUpperCase() + " TRIPPED");

    breaker.recordFailure();
    var result = breaker.gate("hello");
    assertEquals("HELLO TRIPPED", result, "gate transform on tripped");

    breaker.reset(0L);
    var result2 = breaker.gate("hello");
    assertEquals("hello", result2, "gate passthrough on untripped");

    System.out.println("  [PASS] testGateTransform");
}

void testCooldown() {
    var breaker = new CircuitBreaker<String>("test-cooldown", 1, 10,
        ctx -> ctx + " tripped");

    breaker.recordFailure();
    assertTrue(breaker.isTripped(), "tripped");

    breaker.reset(10_000);  // 10 second cooldown
    assertTrue(breaker.isTripped(), "still tripped during cooldown");

    breaker.reset(0);
    assertTrue(!breaker.isTripped(), "not tripped after cooldown reset");

    System.out.println("  [PASS] testCooldown");
}

void testJsonRoundtrip() throws Exception {
    var breaker = new CircuitBreaker<String>("test-json", 2, 10,
        (String ctx) -> ctx + " tripped");
    breaker.recordFailure();
    breaker.recordFailure();  // 2 consecutive = tripped (maxConsecutive=2)

    var json = breaker.toJson();
    var parsed = CircuitBreaker.parse(json);

    assertEquals("test-json", parsed.breakerId(), "parsed breakerId");
    assertEquals(2, parsed.consecutiveFailures(), "parsed consecutive");
    assertEquals(2, parsed.totalFailures(), "parsed total");
    assertTrue(parsed.tripped(), "parsed tripped");

    System.out.println("  [PASS] testJsonRoundtrip");
}

void testLoadOrFresh() throws Exception {
    var tmpDir = java.nio.file.Files.createTempDirectory("cb-test-");
    try {
        var breaker = CircuitBreaker.<String>loadOrFresh(
            tmpDir, "test-persist", 3, 10,
            ctx -> ctx + " tripped");
        breaker.recordFailure();
        breaker.save(tmpDir);

        var loaded = CircuitBreaker.<String>loadOrFresh(
            tmpDir, "test-persist", 3, 10,
            ctx -> ctx + " tripped");
        var s = loaded.state();
        assertEquals(1, s.consecutiveFailures(), "loaded consecutive");
        assertEquals(1, s.totalFailures(), "loaded total");
    } finally {
        deleteDir(tmpDir);
    }

    System.out.println("  [PASS] testLoadOrFresh");
}

void testDenialTracker() {
    var tracker = DenialTracker.<String>create("test-session",
        ctx -> ctx + " ABORTED");

    assertTrue(!tracker.isAborted(), "fresh tracker not aborted");

    var justAborted1 = tracker.recordDenial();
    assertTrue(!justAborted1, "first denial should not abort");
    assertEquals(1, tracker.consecutiveDenials(), "consecutive after 1");
    assertEquals(1, tracker.totalDenials(), "total after 1");

    var justAborted2 = tracker.recordDenial();
    assertTrue(!justAborted2, "second denial should not abort");
    assertEquals(2, tracker.consecutiveDenials(), "consecutive after 2");

    var justAborted3 = tracker.recordDenial();
    assertTrue(justAborted3, "third denial should trigger abort (consecutive max = 3)");
    assertTrue(tracker.isAborted(), "tracker aborted");

    var gated = tracker.gate("prompt");
    assertEquals("prompt ABORTED", gated, "gate applies abort transform");

    System.out.println("  [PASS] testDenialTracker");
}

void testDenialAllows() throws Exception {
    var tmpDir = java.nio.file.Files.createTempDirectory("dt-test-");
    try {
        var tracker = DenialTracker.<String>create("test-session",
            ctx -> ctx + " ABORTED");
        tracker.recordDenial();
        tracker.recordAllow();

        assertEquals(0, tracker.consecutiveDenials(), "consecutive resets after allow");
        assertEquals(1, tracker.totalDenials(), "total still counts");

        var justAborted = tracker.recordDenial();
        assertTrue(!justAborted, "after allow reset, single denial shouldn't abort");

        tracker.save(tmpDir);

        var loaded = DenialTracker.<String>loadOrFresh(
            tmpDir, "test-session", 3, 20,
            ctx -> ctx + " ABORTED");
        assertEquals(1, loaded.consecutiveDenials(), "loaded consecutive — allow resets to 0, then one denial");
        assertEquals(2, loaded.totalDenials(), "loaded total — one early denial + one after allow");
    } finally {
        deleteDir(tmpDir);
    }

    System.out.println("  [PASS] testDenialAllows");
}

void testIronGate() throws Exception {
        var tmpFile = java.io.File.createTempFile("iron-gate-", ".json").toPath();
        try {
            java.nio.file.Files.writeString(tmpFile, "{\"closed\": true}");

            var gate = new IronGate(tmpFile, false, 1800);
            assertTrue(gate.isClosed(), "gate reads closed from file");

            var result = gate.gate("ctx", ctx -> ctx + " BLOCKED");
            assertEquals("ctx BLOCKED", result, "closed gate applies block transform");

            java.nio.file.Files.writeString(tmpFile, "{\"closed\": false}");
            var gate2 = new IronGate(tmpFile, true, 1800);
            assertTrue(gate2.isOpen(), "gate reads open from file");
        } finally {
            tmpFile.toFile().delete();
        }

        System.out.println("  [PASS] testIronGate");
    }

void testBreakerRegistry() throws Exception {
    var tmpDir = java.nio.file.Files.createTempDirectory("br-test-");
    try {
        var registry = new BreakerRegistry<String>(tmpDir);
        var b1 = registry.breaker("b1", 2, 5,
            (String ctx) -> ctx + " tripped");
        var b2 = registry.breaker("b2", 3, 10,
            (String ctx) -> ctx.toUpperCase());

        b1.recordFailure();
        b2.recordFailure();

        assertEquals(1, registry.get("b1").state().consecutiveFailures(), "registry b1");
        assertEquals(1, registry.get("b2").state().consecutiveFailures(), "registry b2");

        registry.saveAll();

        // new registry with same dir should load persisted state
        var registry2 = new BreakerRegistry<String>(tmpDir);
        var loaded = registry2.breaker("b1", 2, 5,
            ctx -> ctx + " different");
        assertEquals(1, loaded.state().consecutiveFailures(), "loaded state from persistence");

        registry.reset("b1");
        assertEquals(0, registry.get("b1").state().consecutiveFailures(), "reset b1");
    } finally {
        deleteDir(tmpDir);
    }

    System.out.println("  [PASS] testBreakerRegistry");
}

void deleteDir(java.nio.file.Path dir) {
    try (var s = java.nio.file.Files.walk(dir)) {
        s.sorted(java.util.Comparator.reverseOrder())
            .forEach(p -> { try { java.nio.file.Files.deleteIfExists(p); } catch (Exception ignored) {} });
    } catch (Exception ignored) {}
}
