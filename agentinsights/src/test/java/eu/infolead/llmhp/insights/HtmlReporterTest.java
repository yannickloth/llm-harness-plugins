package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.io.*;
import java.nio.file.*;

public class HtmlReporterTest {
    static int passed = 0, failed = 0;

    public static void main(String[] args) {
        testEmptyReport();
        testMinimalReport();
        testReportWithInsights();
        testEscBold();

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void testEmptyReport() {
        var data = AggregatedData.empty();
        var insights = new InsightResults(
            java.util.Optional.empty(), java.util.Optional.empty(),
            java.util.Optional.empty(), java.util.Optional.empty(),
            java.util.Optional.empty(), java.util.Optional.empty(),
            java.util.Optional.empty(), java.util.Optional.empty()
        );

        var html = HtmlReporter.generate(data, insights);
        assertContains("<html", html, "has html tag");
        assertContains("AI Coding Insights", html, "has title");
        assertContains("0 sessions", html, "shows zero sessions");
    }

    static void testMinimalReport() {
        var data = AggregatedData.empty();

        var atAGlance = new InsightResults.AtAGlance(
            "Style works well", "Context issues", "Try agents", "Prepare for autonomy");

        var insights = new InsightResults(
            java.util.Optional.of(atAGlance), java.util.Optional.empty(),
            java.util.Optional.empty(), java.util.Optional.empty(),
            java.util.Optional.empty(), java.util.Optional.empty(),
            java.util.Optional.empty(), java.util.Optional.empty()
        );

        var html = HtmlReporter.generate(data, insights);
        assertContains("Style works well", html, "at a glance what's working");
        assertContains("Context issues", html, "at a glance what's hindering");
    }

    static void testReportWithInsights() {
        var data = AggregatedData.empty();

        var atAGlance = new InsightResults.AtAGlance("w", "h", "qw", "aw");
        var pa = new InsightResults.ProjectAreas(java.util.List.of(
            new InsightResults.ProjectAreas.Area("Backend", 10, "API work"),
            new InsightResults.ProjectAreas.Area("Frontend", 5, "UI work")
        ));
        var is = new InsightResults.InteractionStyle("User delegates well.", "Batch mode");
        var ww = new InsightResults.WhatWorks("Great progress", java.util.List.of(
            new InsightResults.WhatWorks.ImpressiveWorkflow("Refactor", "Big cleanup")
        ));
        var fa = new InsightResults.FrictionAnalysis("Minor issues", java.util.List.of(
            new InsightResults.FrictionAnalysis.FrictionCategory("Buggy Code", "Issues with edge cases",
                java.util.Optional.of(java.util.List.of("Example 1")))
        ));
        var sugg = new InsightResults.Suggestions(
            java.util.List.of(new InsightResults.Suggestions.ClaudeMdAddition("Always test", "Catches bugs", "Testing")),
            java.util.List.of(new InsightResults.Suggestions.FeatureToTry("Hooks", "Auto-run commands", "You'd benefit",
                java.util.Optional.of("example"))),
            java.util.List.of(new InsightResults.Suggestions.UsagePattern("Batch", "Group edits", java.util.Optional.of("Detail"),
                java.util.Optional.of("Try this")))
        );
        var oh = new InsightResults.OnTheHorizon("Future is bright", java.util.List.of(
            new InsightResults.OnTheHorizon.Opportunity("Auto PRs", "Agents review PRs", java.util.Optional.of("Use agents"),
                java.util.Optional.of("Review PR #42"))
        ));
        var fe = new InsightResults.FunEnding("The cat sat on the keyboard", "Session 42");

        var insights = new InsightResults(
            java.util.Optional.of(atAGlance), java.util.Optional.of(pa),
            java.util.Optional.of(is), java.util.Optional.of(ww),
            java.util.Optional.of(fa), java.util.Optional.of(sugg),
            java.util.Optional.of(oh), java.util.Optional.of(fe)
        );

        var html = HtmlReporter.generate(data, insights);
        assertContains("Backend", html, "project area");
        assertContains("Frontend", html, "project area 2");
        assertContains("delegates", html, "interaction style");
        assertContains("Refactor", html, "what works");
        assertContains("Buggy Code", html, "friction");
        assertContains("Always test", html, "suggestion");
        assertContains("Future is bright", html, "horizon intro");
        assertContains("cat sat", html, "fun ending");
    }

    static void testEscBold() {
        var html = HtmlReporter.generate(AggregatedData.empty(), new InsightResults(
            java.util.Optional.of(new InsightResults.AtAGlance(
                "User **excels** at testing", "No **major** issues", "Try **hooks**", "**Autonomous** agents")),
            java.util.Optional.empty(), java.util.Optional.empty(), java.util.Optional.empty(),
            java.util.Optional.empty(), java.util.Optional.empty(), java.util.Optional.empty(),
            java.util.Optional.empty()
        ));
        assertContains("<strong>excels</strong>", html, "bold converted to strong");
        assertContains("<strong>major</strong>", html, "bold hindering");
        assertMissing("**excels**", html, "raw asterisks not present");
    }

    static void assertContains(String needle, String haystack, String msg) {
        if (haystack.contains(needle)) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] '%s' not found\n", msg, needle);
        }
    }

    static void assertMissing(String needle, String haystack, String msg) {
        if (!haystack.contains(needle)) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] '%s' unexpectedly found\n", msg, needle);
        }
    }
}
