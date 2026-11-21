package eu.infolead.llmhp.router;

/** Minimal test harness (repo convention: plain main() asserting, no JUnit). */
public final class ClassifierTest {

    static int passed = 0, failed = 0;

    public static void main(String... args) {
        var c = new Classifier();

        // ── bands: sergeant < warrant-officer < lieutenant ──
        check(Tier.SERGEANT.relativeCost() < Tier.WARRANT_OFFICER.relativeCost(), "sergeant cheaper than warrant-officer");
        check(Tier.WARRANT_OFFICER.relativeCost() < Tier.LIEUTENANT.relativeCost(), "warrant-officer cheaper than lieutenant");
        check(Tier.values().length == 3, "three bands");
        check(Tier.WARRANT_OFFICER.proxyName().equals("warrant-officer"), "proxy name is hyphenated");
        check(Tier.from("warrant-officer") == Tier.WARRANT_OFFICER, "hyphenated tier parses");
        check(Tier.from("lieutenant") == Tier.LIEUTENANT, "lieutenant parses");

        // ── keyword bands ──
        check(c.keywordMatch("add semicolon to Foo.java") == Tier.SERGEANT, "semicolon -> sergeant");
        check(c.keywordMatch("close bracket in Foo.java") == Tier.SERGEANT, "close bracket -> sergeant");
        check(c.keywordMatch("rename foo to bar in Foo.java") == Tier.SERGEANT, "rename -> sergeant");
        check(c.keywordMatch("implement the parser in Parser.java") == Tier.WARRANT_OFFICER, "implement -> warrant-officer");
        check(c.keywordMatch("prove the theorem") == Tier.LIEUTENANT, "prove -> lieutenant");
        check(c.keywordMatch("formalize the invariant") == Tier.LIEUTENANT, "formalize -> lieutenant");
        check(c.keywordMatch("design a new architecture") == null, "design has no keyword band");

        // ── confidence ──
        check(c.keywordConfidence("add semicolon to Foo.java", Tier.SERGEANT) > 0.0, "sergeant confidence positive");

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
