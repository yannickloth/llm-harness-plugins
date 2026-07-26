package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.time.Instant;
import java.util.*;

public class AggregatorTest {
    static int passed = 0, failed = 0;

    public static void main(String[] args) {
        testEmptyAggregation();
        testSingleSession();
        testMultipleSessions();
        testFacetAggregation();
        testDerivedStats();

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static SessionMeta makeMeta(String id, int userMsgs, int durationMin, int commits,
                                 Map<String, Integer> tools, Map<String, Integer> langs,
                                 boolean taskAgent) {
        return new SessionMeta(id, "proj", Instant.EPOCH.toString(), durationMin,
            userMsgs, 5, tools, langs, commits, 2,
            1000, 500, "hello", Optional.empty(), 1,
            List.of(5.0, 10.0), 2, Map.of("Command Failed", 1),
            taskAgent, false, true, false,
            20, 5, 3, List.of(10, 14), List.of(Instant.EPOCH.toString()), 0);
    }

    static void testEmptyAggregation() {
        var result = Aggregator.aggregate(List.of(), Map.of());
        assertIntEq(0, result.totalSessions(), "empty totalSessions");
        assertIntEq(0, result.sessionsWithFacets(), "empty withFacets");
        assertIntEq(0, result.gitCommits(), "empty commits");
    }

    static void testSingleSession() {
        var meta = makeMeta("s1", 5, 30, 3,
            Map.of("Read", 5, "Edit", 3), Map.of("Java", 8), true);

        var result = Aggregator.aggregate(List.of(meta), Map.of());

        assertIntEq(1, result.totalSessions(), "single totalSessions");
        assertEq(0.5, result.totalDurationHours(), 0.01, "single duration");
        assertIntEq(3, result.gitCommits(), "single commits");
        assertIntEq(8, result.toolCounts().getOrDefault("Read", 0) + result.toolCounts().getOrDefault("Edit", 0), "tool counts");
        assertIntEq(1, result.sessionsUsingTaskAgent(), "task agent count");
        assertIntEq(1, result.sessionsUsingWebSearch(), "web search count");
        assertEquals(20, result.totalLinesAdded(), "lines added");
        assertEquals(5, result.totalLinesRemoved(), "lines removed");
    }

    static void testMultipleSessions() {
        var meta1 = makeMeta("s1", 3, 20, 1,
            Map.of("Read", 3), Map.of("Python", 5), false);
        var meta2 = makeMeta("s2", 7, 40, 5,
            Map.of("Edit", 4, "Bash", 2), Map.of("Java", 3, "Python", 2), true);

        var result = Aggregator.aggregate(List.of(meta1, meta2), Map.of());

        assertIntEq(2, result.totalSessions(), "multi totalSessions");
        assertIntEq(6, result.gitCommits(), "multi commits");
        assertIntEq(1, result.sessionsUsingTaskAgent(), "one has task agent");
        boolean hasPython = result.languages().getOrDefault("Python", 0) == 7;
        assertResult("languages aggregated", hasPython);
    }

    static void testFacetAggregation() {
        var meta = makeMeta("s1", 5, 30, 2,
            Map.of("Read", 5), Map.of("Java", 5), false);

        var facets = new SessionFacets("s1", "build a feature",
            Map.of("implement_feature", 2),
            "mostly_achieved",
            Map.of("satisfied", 1, "happy", 1),
            "very_helpful", "single_task",
            Map.of("buggy_code", 1),
            "code had issues but resolved",
            "correct_code_edits",
            "user wanted feature, mostly got it",
            Optional.empty(), 0);

        var result = Aggregator.aggregate(List.of(meta), Map.of("s1", facets));

        assertIntEq(1, result.sessionsWithFacets(), "facet count");
        assertIntEq(2, (int) result.goalCategories().getOrDefault("implement_feature", 0), "goal cats");
        assertIntEq(1, (int) result.outcomes().getOrDefault("mostly_achieved", 0), "outcomes");
        assertIntEq(1, result.helpfulness().getOrDefault("very_helpful", 0), "helpfulness");
        assertIntEq(1, result.friction().getOrDefault("buggy_code", 0), "friction");
    }

    static void testDerivedStats() {
        var meta1 = makeMeta("s1", 3, 30, 1,
            Map.of("Read", 2), Map.of("Java", 3), false);
        var meta2 = makeMeta("s2", 5, 20, 0,
            Map.of("Edit", 3), Map.of("Python", 4), false);

        var result = Aggregator.aggregate(List.of(meta1, meta2), Map.of());

        assertIntEq(2, result.totalSessions(), "derived sessions");
        boolean hasMedian = result.medianResponseTime() > 0;
        assertResult("median response time computed", hasMedian);
        boolean hasAvg = result.avgResponseTime() > 0;
        assertResult("avg response time computed", hasAvg);
    }

    static void assertEq(double expected, double actual, double tolerance, String msg) {
        if (Math.abs(expected - actual) < tolerance) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] expected=%.2f actual=%.2f\n", msg, expected, actual);
        }
    }

    static void assertIntEq(int expected, int actual, String msg) {
        if (expected == actual) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] expected=%d actual=%d\n", msg, expected, actual);
        }
    }

    static void assertEquals(long expected, long actual, String msg) {
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
