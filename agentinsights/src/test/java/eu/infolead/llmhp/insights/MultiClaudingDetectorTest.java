package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public class MultiClaudingDetectorTest {
    static int passed = 0, failed = 0;

    public static void main(String[] args) {
        testNoOverlap();
        testSingleSession();
        testOverlappingSessions();
        testEmpty();
        testNonOverlappingTimestamps();
        testThreeWayOverlap();

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static SessionMeta makeSession(String id, String... timestamps) {
        return new SessionMeta(id, "", "", 10, 3, 3,
            Map.of(), Map.of(), 0, 0, 0, 0, "test",
            Optional.empty(), 0, List.of(), 0, Map.of(),
            false, false, false, false, 0, 0, 0,
            List.of(), List.of(timestamps), 0);
    }

    static String ts(int minutesOffset) {
        return Instant.EPOCH.plusSeconds(minutesOffset * 60L).toString();
    }

    static void testNoOverlap() {
        var sessions = List.of(
            makeSession("s1", ts(0), ts(5)),
            makeSession("s2", ts(60), ts(65))
        );
        var result = MultiClaudingDetector.detect(sessions);
        assertIntEq(0, result.overlapEvents(), "no overlap events");
    }

    static void testSingleSession() {
        var sessions = List.of(makeSession("s1", ts(0), ts(5), ts(10)));
        var result = MultiClaudingDetector.detect(sessions);
        assertIntEq(0, result.overlapEvents(), "single session no overlap");
        assertIntEq(0, result.sessionsInvolved(), "single session not involved");
    }

    static void testOverlappingSessions() {
        var sessions = List.of(
            makeSession("s1", ts(0), ts(15)),
            makeSession("s2", ts(5), ts(10)),
            makeSession("s1", ts(20))
        );
        var result = MultiClaudingDetector.detect(sessions);
        assertIntEq(1, result.overlapEvents(), "simple overlap detected");
        assertIntEq(2, result.sessionsInvolved(), "both sessions involved");
    }

    static void testEmpty() {
        var result = MultiClaudingDetector.detect(List.of());
        assertIntEq(0, result.overlapEvents(), "empty no events");
        assertIntEq(0, result.sessionsInvolved(), "empty no involved");
    }

    static void testNonOverlappingTimestamps() {
        var sessions = List.of(
            makeSession("s1", ts(0)),
            makeSession("s2", ts(40)),
            makeSession("s1", ts(50))
        );
        var result = MultiClaudingDetector.detect(sessions);
        assertIntEq(0, result.overlapEvents(), ">30min gap no overlap");
    }

    static void testThreeWayOverlap() {
        var sessions = List.of(
            makeSession("s1", ts(0), ts(15)),
            makeSession("s2", ts(5), ts(20)),
            makeSession("s3", ts(10), ts(25)),
            makeSession("s1", ts(30))
        );
        var result = MultiClaudingDetector.detect(sessions);
        boolean hasOverlaps = result.overlapEvents() > 0;
        assertResult("three-way overlap detected", hasOverlaps);
        boolean allInvolved = result.sessionsInvolved() >= 2;
        assertResult("multiple sessions involved", allInvolved);
    }

    static void assertIntEq(int expected, int actual, String msg) {
        if (expected == actual) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] expected=%d actual=%d\n", msg, expected, actual);
        }
    }

    static void assertResult(String name, boolean condition) {
        if (condition) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s]\n", name);
        }
    }
}
