package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.util.*;

public class MarkdownSummarizerTest {
    static int passed = 0, failed = 0;

    public static void main(String[] args) {
        testBasicSummary();
        testEmpty();
        testFriction();

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void testBasicSummary() {
        var data = AggregatedData.empty();
        var atAGlance = new InsightResults.AtAGlance("works", "hinders", "wins", "horizon");
        var insights = new InsightResults(
            Optional.of(atAGlance), Optional.empty(), Optional.empty(), Optional.empty(),
            Optional.empty(), Optional.empty(), Optional.empty(),
            Optional.of(new InsightResults.FunEnding("A funny moment", "Session 42"))
        );

        var md = MarkdownSummarizer.generate(data, insights, "/path/to/report.html");
        assertContains("Insights Report", md, "header");
        assertContains("At a Glance", md, "at a glance section");
        assertContains("Key Stats", md, "key stats section");
        assertContains("/path/to/report.html", md, "report link");
        assertContains("A funny moment", md, "fun ending");
    }

    static void testEmpty() {
        var data = AggregatedData.empty();
        var insights = new InsightResults(
            Optional.empty(), Optional.empty(), Optional.empty(), Optional.empty(),
            Optional.empty(), Optional.empty(), Optional.empty(), Optional.empty()
        );

        var md = MarkdownSummarizer.generate(data, insights, "/rpt");
        assertContains("Insights Report", md, "empty has header");
    }

    static void testFriction() {
        var data = AggregatedData.empty();
        var fa = new InsightResults.FrictionAnalysis("Some friction", List.of(
            new InsightResults.FrictionAnalysis.FrictionCategory("Slow", "Took too long", Optional.empty())
        ));
        var insights = new InsightResults(
            Optional.empty(), Optional.empty(), Optional.empty(), Optional.empty(),
            Optional.of(fa), Optional.empty(), Optional.empty(), Optional.empty()
        );

        var md = MarkdownSummarizer.generate(data, insights, "/rpt");
        assertContains("Friction Areas", md, "friction section");
        assertContains("Slow", md, "friction category");
    }

    static void assertContains(String needle, String haystack, String msg) {
        if (haystack.contains(needle)) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] '%s' not found\n", msg, needle);
        }
    }
}
