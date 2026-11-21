package eu.infolead.llmhp.router;

/** Minimal test harness (repo convention: plain main() asserting, no JUnit). */
public final class ClassifierTest {

    static int passed = 0, failed = 0;

    public static void main(String... args) {
        var c = new Classifier();

        // ── tier order: Haiku < Sonnet < Opus < Fable ──
        check(Tier.HAIKU.relativeCost() < Tier.SONNET.relativeCost(), "haiku cheaper than sonnet");
        check(Tier.SONNET.relativeCost() < Tier.OPUS.relativeCost(), "sonnet cheaper than opus");
        check(Tier.OPUS.relativeCost() < Tier.FABLE.relativeCost(), "opus cheaper than fable");
        check(Tier.from("fable") == Tier.FABLE, "fable parses");

        // ── keyword bands ──
        check(c.keywordMatch("add semicolon to Foo.java") == Tier.HAIKU, "semicolon -> haiku");
        check(c.keywordMatch("close bracket in Foo.java") == Tier.HAIKU, "close bracket -> haiku");
        check(c.keywordMatch("rename foo to bar in Foo.java") == Tier.HAIKU, "rename -> haiku");
        check(c.keywordMatch("implement the parser in Parser.java") == Tier.SONNET, "implement -> sonnet");
        check(c.keywordMatch("prove the theorem") == Tier.OPUS, "prove -> opus");
        check(c.keywordMatch("formalize the invariant") == Tier.OPUS, "formalize -> opus");
        check(c.keywordMatch("design a new architecture") == null, "design has no keyword band");
        check(c.keywordMatch("prove the theorem") != Tier.FABLE, "fable is never keyword-matched");

        // ── confidence: fable has no keyword band ──
        check(c.keywordConfidence("prove the theorem", Tier.FABLE) == 0.0, "fable confidence 0");
        check(c.keywordConfidence("add semicolon to Foo.java", Tier.HAIKU) > 0.0, "haiku confidence positive");

        // ── skill-axis table carries gateway names ──
        var json = """
            { "mappings": [
              {"axis": "reasoning",  "model": "major",          "initial": null,      "matchType": "direct",     "note": "x"},
              {"axis": "fast_tools", "model": "deepseek-flash", "initial": "sergeant", "matchType": "generalist", "note": "y"}
            ] }
            """;
        var mappings = SkillAxisConfig.parseMapping(json);
        check(mappings.size() == 2, "two mappings parsed");
        check(mappings.get(0).model().equals("major"), "rank model parsed");
        check(mappings.get(1).initial().equals("sergeant"), "rank initial parsed");
        check(mappings.get(1).matchType() == SkillAxisMapping.MatchType.generalist, "match type parsed");

        System.out.printf("ClassifierTest: %d passed, %d failed%n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void check(boolean cond, String msg) {
        if (cond) {
            passed++;
        } else {
            failed++;
            System.out.println("  FAIL: " + msg);
        }
    }
}
