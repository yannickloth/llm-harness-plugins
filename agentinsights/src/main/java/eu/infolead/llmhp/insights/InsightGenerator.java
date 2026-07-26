package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.util.*;
import java.util.concurrent.*;

public final class InsightGenerator {

    record Section(String name, String prompt, int maxTokens) {}

    static String getFeaturesReference(String platform) {
        if ("opencode".equalsIgnoreCase(platform)) {
            return """
                ## PLATFORM FEATURES REFERENCE

                1. **CLAUDE.md / AGENTS.md**: Project-level instructions that automatically apply to all sessions.
                   - How to use: Create `CLAUDE.md` or `AGENTS.md` in project root with conventions and preferences.
                   - Good for: coding conventions, testing requirements, architecture constraints.

                2. **Custom Slash Commands**: Reusable prompts run with a single /command.
                   - How to use: Define in `.opencode/commands/<name>.md`.
                   - Good for: repetitive workflows like /commit, /review, /test.

                3. **Hooks / Plugins**: Auto-running event handlers on session events.
                   - How to use: Configure in `opencode.json` under "plugin" key.
                   - Good for: auto-formatting, type checking, memory injection.

                4. **Headless Mode**: Run agent non-interactively from scripts and CI/CD.
                   - How to use: `opencode run --agent <name> <prompt>`
                   - Good for: CI/CD integration, batch code fixes, automated reviews.

                5. **Task Agents / Subagents**: Focused sub-agents for complex exploration or parallel work.
                   - How to use: Agent auto-invokes when helpful, or ask "use an agent to explore X".
                   - Good for: codebase exploration, understanding complex systems.

                6. **MCP Tools**: External tool integrations via Model Context Protocol.
                   - How to use: Configure in `opencode.json` under "mcpServers".
                   - Good for: connecting to APIs, databases, external services.
                """;
        }
        if ("claude".equalsIgnoreCase(platform)) {
            return """
                ## PLATFORM FEATURES REFERENCE

                1. **Custom Commands**: Reusable prompts you define as markdown files that run with a single /command.
                   - How to use: Create `commands/<name>.md` in your project or config.
                   - Good for: repetitive workflows - /commit, /review, /test, /deploy.

                2. **CLAUDE.md**: Project-level instructions that Claude Code automatically reads.
                   - How to use: Create a `CLAUDE.md` file in project root with coding conventions.
                   - Good for: telling Claude about your project's architecture, conventions, and preferences.

                3. **Hooks**: Shell commands that auto-run at specific lifecycle events.
                   - How to use: Add to `.claude/settings.json` under "hooks" key.
                   - Good for: auto-formatting code, running type checks, enforcing conventions.

                4. **Headless Mode**: Run Claude Code non-interactively from scripts and CI/CD.
                   - How to use: `claude -p "fix lint errors" --allowedTools "Edit,Read,Bash"`
                   - Good for: CI/CD integration, batch code fixes, automated reviews.

                5. **Task Agents**: Claude spawns focused sub-agents for complex exploration or parallel work.
                   - How to use: Claude auto-invokes when helpful, or ask "use an agent to explore X".
                   - Good for: codebase exploration, understanding complex systems.

                6. **Plugins**: Extend Claude Code with custom tools, hooks, and commands.
                   - How to use: `/plugin install <name>` or `/plugin marketplace add <url>`.
                   - Good for: memory systems, custom integrations, specialized workflows.
                """;
        }
        return """
            ## PLATFORM FEATURES REFERENCE

            1. **CLAUDE.md / AGENTS.md**: Project-level instructions that automatically apply to all sessions.
            2. **Custom Commands**: Reusable prompts run with a single /command.
            3. **Hooks**: Shell commands that auto-run at specific lifecycle events.
            4. **Headless Mode**: Run agent non-interactively from scripts and CI/CD.
            5. **Task Agents**: Focused sub-agents for complex exploration or parallel work.
            6. **Memory Systems**: Persistent memory plugins that learn across sessions.
            """;
    }

    static List<Section> buildSections(String platform) {
        var featRef = getFeaturesReference(platform);
        return List.of(
            new Section("project_areas", """
                Analyze this AI coding agent usage data and identify project areas.

                RESPOND WITH ONLY A VALID JSON OBJECT:
                {
                  "areas": [
                    {"name": "Project area name", "session_count": 5, "description": "What the user works on in this area"}
                  ]
                }

                Include 3-5 areas. Group related sessions together.""", 8192),
            new Section("interaction_style", """
                Analyze this AI coding agent usage data and describe the interaction style.

                RESPOND WITH ONLY A VALID JSON OBJECT:
                {
                  "narrative": "3-4 sentences describing HOW the user interacts - their style, pace, approach to delegation",
                  "key_pattern": "One notable pattern in their usage"
                }""", 8192),
            new Section("what_works", """
                Analyze this AI coding agent usage data and identify what worked well.

                RESPOND WITH ONLY A VALID JSON OBJECT:
                {
                  "intro": "1-2 sentences celebrating what went well",
                  "impressive_workflows": [
                    {"title": "Short title (4-8 words)", "description": "2-3 sentences about what was achieved"}
                  ]
                }

                Include 3-5 impressive workflows. Focus on concrete accomplishments.""", 8192),
            new Section("friction_analysis", """
                Analyze this AI coding agent usage data and identify friction points.

                RESPOND WITH ONLY A VALID JSON OBJECT:
                {
                  "intro": "1-2 sentences about overall friction patterns",
                  "categories": [
                    {"category": "Category name", "description": "2-3 sentences about this friction pattern", "examples": ["example from transcripts"]}
                  ]
                }

                Include 3-5 friction categories. Be constructive, not critical.""", 8192),
            new Section("suggestions", """
                Analyze this AI coding agent usage data and suggest improvements.

                """ + featRef + """

                RESPOND WITH ONLY A VALID JSON OBJECT:
                {
                  "claude_md_additions": [
                    {"addition": "A specific line or block to add to your instruction file", "why": "1 sentence explaining why", "prompt_scaffold": "Where to add"}
                  ],
                  "features_to_try": [
                    {"feature": "Feature name from PLATFORM FEATURES REFERENCE", "one_liner": "What it does", "why_for_you": "Why this would help", "example_code": "Command or config to copy"}
                  ],
                  "usage_patterns": [
                    {"title": "Short title", "suggestion": "1-2 sentence summary", "detail": "3-4 sentences explaining how this applies to YOUR work", "copyable_prompt": "A specific prompt to copy and try"}
                  ]
                }

                For instruction additions: PRIORITIZE instructions appearing MULTIPLE TIMES.
                For features_to_try: Pick 2-3 from PLATFORM FEATURES REFERENCE.
                Include 2-3 items per category.""", 8192),
            new Section("on_the_horizon", """
                Analyze this AI coding agent usage data and identify future opportunities.

                RESPOND WITH ONLY A VALID JSON OBJECT:
                {
                  "intro": "1 sentence about evolving AI-assisted development",
                  "opportunities": [
                    {"title": "Short title (4-8 words)", "whats_possible": "2-3 ambitious sentences about autonomous workflows", "how_to_try": "1-2 sentences mentioning relevant tooling", "copyable_prompt": "Detailed prompt to try"}
                  ]
                }

                Include 3 opportunities. Think BIG - autonomous workflows, parallel agents, iterating against tests.""", 8192),
            new Section("fun_ending", """
                Analyze this AI coding agent usage data and find a memorable moment.

                RESPOND WITH ONLY A VALID JSON OBJECT:
                {
                  "headline": "A memorable QUALITATIVE moment from the transcripts - not a statistic",
                  "detail": "Brief context about when/where this happened"
                }

                Find something genuinely interesting or amusing from the session summaries.""", 8192)
        );
    }

    public static InsightResults generateFacade(FacetExtractor.LlmClient llm, AggregatedData data,
                                                 Map<String, SessionFacets> facetsMap,
                                                 String platform, List<String> sectionFailures) throws Exception {
        var sections = buildSections(platform);
        var dataContext = buildDataContext(data, facetsMap);

        var results = new ConcurrentHashMap<String, Object>();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = new ArrayList<Future<?>>();
            for (var section : sections) {
                futures.add(executor.submit(() -> {
                    try {
                        var result = generateSection(llm, section, dataContext);
                        if (result != null) results.put(section.name(), result);
                        else sectionFailures.add(section.name());
                    } catch (Exception e) {
                        sectionFailures.add(section.name());
                    }
                }));
            }
            for (var f : futures) {
                try { f.get(); } catch (Exception ignored) {}
            }
        }

        var atAGlance = generateAtAGlance(llm, dataContext, new HashMap<>(results));
        if (atAGlance != null) results.put("at_a_glance", atAGlance);

        return new InsightResults(
            Optional.ofNullable(buildAtAGlance(asMap(results.get("at_a_glance")))),
            Optional.ofNullable(buildProjectAreas(asMap(results.get("project_areas")))),
            Optional.ofNullable(buildInteractionStyle(asMap(results.get("interaction_style")))),
            Optional.ofNullable(buildWhatWorks(asMap(results.get("what_works")))),
            Optional.ofNullable(buildFriction(asMap(results.get("friction_analysis")))),
            Optional.ofNullable(buildSuggestions(asMap(results.get("suggestions")))),
            Optional.ofNullable(buildHorizon(asMap(results.get("on_the_horizon")))),
            Optional.ofNullable(buildFunEnding(asMap(results.get("fun_ending"))))
        );
    }

    static Map<?, ?> asMap(Object v) {
        return v instanceof Map<?, ?> m ? m : null;
    }

    static Object generateSection(FacetExtractor.LlmClient llm, Section section, String dataContext)
            throws Exception {
        var prompt = section.prompt() + "\n\nDATA:\n" + dataContext;
        var response = llm.complete("", prompt, section.maxTokens());
        var json = FacetExtractor.extractJson(response);
        if (json == null) return null;
        try {
            var parsed = ManualJson.parse(json);
            if (parsed instanceof Map<?, ?> m) return m;
            return null;
        } catch (Exception e) { return null; }
    }

    static Object generateAtAGlance(FacetExtractor.LlmClient llm, String fullContext,
                                     Map<String, Object> sectionResults) throws Exception {
        var projectAreasText = extractTextList(sectionResults, "project_areas", "areas", "name", "description");
        var winsText = extractTextList(sectionResults, "what_works", "impressive_workflows", "title", "description");
        var frictionText = extractTextList(sectionResults, "friction_analysis", "categories", "category", "description");
        var featuresText = extractTextList(sectionResults, "suggestions", "features_to_try", "feature", "one_liner");
        var patternsText = extractTextList(sectionResults, "suggestions", "usage_patterns", "title", "suggestion");
        var horizonText = extractTextList(sectionResults, "on_the_horizon", "opportunities", "title", "whats_possible");

        var prompt = """
            You're writing an "At a Glance" summary for an AI coding agent usage insights report.
            Use this 4-part structure:

            1. **What's working** - What is the user's unique style. Keep high level. Don't be fluffy.
            2. **What's hindering you** - (a) Agent's fault + (b) user-side friction. Be honest but constructive.
            3. **Quick wins to try** - Specific features or workflow techniques.
            4. **Ambitious workflows for better models** - As models improve over next 3-6 months, what to prepare for.

            Keep each section to 2-3 sentences. Don't use numerical stats. Coaching tone.

            RESPOND WITH ONLY A VALID JSON OBJECT:
            {"whats_working": "...", "whats_hindering": "...", "quick_wins": "...", "ambitious_workflows": "..."}

            SESSION DATA:
            """ + fullContext + """

            ## Project Areas
            """ + projectAreasText + """

            ## Big Wins
            """ + winsText + """

            ## Friction Categories
            """ + frictionText + """

            ## Features to Try
            """ + featuresText + """

            ## Usage Patterns
            """ + patternsText + """

            ## On the Horizon
            """ + horizonText;

        var response = llm.complete("", prompt, 8192);
        var json = FacetExtractor.extractJson(response);
        if (json == null) return null;
        try {
            var parsed = ManualJson.parse(json);
            if (parsed instanceof Map<?, ?> m) return m;
            return null;
        } catch (Exception e) { return null; }
    }

    static String extractTextList(Map<String, Object> results, String section, String listKey,
                                   String field1, String field2) {
        if (!results.containsKey(section)) return "";
        var sec = results.get(section);
        if (!(sec instanceof Map<?, ?> sm)) return "";
        var list = sm.get(listKey);
        if (!(list instanceof List<?> items)) return "";
        var sb = new StringBuilder();
        for (var item : items) {
            if (item instanceof Map<?, ?> im) {
                sb.append("- ").append(im.get(field1)).append(": ").append(im.get(field2)).append("\n");
            }
        }
        return sb.toString();
    }

    static String buildDataContext(AggregatedData data, Map<String, SessionFacets> facetsMap) {
        var facetSummaries = new StringBuilder();
        var count = 0;
        for (var f : facetsMap.values()) {
            if (count++ >= 50) break;
            facetSummaries.append("- ").append(f.briefSummary())
                .append(" (").append(f.outcome()).append(", ").append(f.claudeHelpfulness()).append(")\n");
        }
        var frictionDetails = new StringBuilder();
        count = 0;
        for (var f : facetsMap.values()) {
            if (!f.frictionDetail().isBlank() && count++ < 20)
                frictionDetails.append("- ").append(f.frictionDetail()).append("\n");
        }
        var userInstructions = new StringBuilder();
        count = 0;
        for (var f : facetsMap.values()) {
            var instructions = f.userInstructionsToClaude();
            if (instructions.isPresent()) {
                for (var instr : instructions.get()) {
                    if (count++ < 15) userInstructions.append("- ").append(instr).append("\n");
                }
            }
        }

        var topTools = data.toolCounts().entrySet().stream()
            .sorted((a, b) -> b.getValue().compareTo(a.getValue()))
            .limit(8).map(e -> e.getKey() + ": " + e.getValue()).toList();
        var topGoals = data.goalCategories().entrySet().stream()
            .sorted((a, b) -> b.getValue().compareTo(a.getValue()))
            .limit(8).map(e -> e.getKey() + ": " + e.getValue()).toList();

        var stats = new LinkedHashMap<String, Object>();
        stats.put("sessions", data.totalSessions());
        stats.put("analyzed", data.sessionsWithFacets());
        stats.put("date_range", data.dateRange().start() + " to " + data.dateRange().end());
        stats.put("messages", data.totalMessages());
        stats.put("hours", (int) data.totalDurationHours());
        stats.put("commits", data.gitCommits());
        stats.put("top_tools", topTools);
        stats.put("top_goals", topGoals);
        stats.put("outcomes", data.outcomes());
        stats.put("satisfaction", data.satisfaction());
        stats.put("friction", data.friction());
        stats.put("success", data.success());
        stats.put("languages", data.languages());

        return ManualJson.toJson(stats)
            + "\n\nSESSION SUMMARIES:\n" + facetSummaries
            + "\n\nFRICTION DETAILS:\n" + frictionDetails
            + "\n\nUSER INSTRUCTIONS:\n" + (userInstructions.isEmpty() ? "None captured" : userInstructions);
    }

    static InsightResults.AtAGlance buildAtAGlance(Map<?, ?> map) {
        if (map == null) return null;
        return new InsightResults.AtAGlance(
            str(map, "whats_working"), str(map, "whats_hindering"),
            str(map, "quick_wins"), str(map, "ambitious_workflows"));
    }

    static InsightResults.ProjectAreas buildProjectAreas(Map<?, ?> map) {
        if (map == null) return null;
        var areas = map.get("areas");
        if (!(areas instanceof List<?> list)) return null;
        var result = new ArrayList<InsightResults.ProjectAreas.Area>();
        for (var a : list) {
            if (a instanceof Map<?, ?> am) {
                int c = 0;
                var raw = am.get("session_count");
                if (raw instanceof Number n) c = n.intValue();
                result.add(new InsightResults.ProjectAreas.Area(
                    str(am, "name"), c, str(am, "description")));
            }
        }
        return new InsightResults.ProjectAreas(result);
    }

    static InsightResults.InteractionStyle buildInteractionStyle(Map<?, ?> map) {
        if (map == null) return null;
        return new InsightResults.InteractionStyle(str(map, "narrative"), str(map, "key_pattern"));
    }

    static InsightResults.WhatWorks buildWhatWorks(Map<?, ?> map) {
        if (map == null) return null;
        var list = map.get("impressive_workflows");
        if (!(list instanceof List<?> workflows)) return null;
        var wfs = new ArrayList<InsightResults.WhatWorks.ImpressiveWorkflow>();
        for (var w : workflows) {
            if (w instanceof Map<?, ?> wm)
                wfs.add(new InsightResults.WhatWorks.ImpressiveWorkflow(str(wm, "title"), str(wm, "description")));
        }
        return new InsightResults.WhatWorks(str(map, "intro"), wfs);
    }

    static InsightResults.FrictionAnalysis buildFriction(Map<?, ?> map) {
        if (map == null) return null;
        var list = map.get("categories");
        if (!(list instanceof List<?> categories)) return null;
        var cats = new ArrayList<InsightResults.FrictionAnalysis.FrictionCategory>();
        for (var c : categories) {
            if (c instanceof Map<?, ?> cm) {
                List<String> exList;
                if (cm.get("examples") instanceof List<?> ex) {
                    exList = new ArrayList<>();
                    for (var item : ex) { if (item instanceof String s) exList.add(s); }
                } else {
                    exList = List.of();
                }
                cats.add(new InsightResults.FrictionAnalysis.FrictionCategory(
                    str(cm, "category"), str(cm, "description"), Optional.of(exList)));
            }
        }
        return new InsightResults.FrictionAnalysis(str(map, "intro"), cats);
    }

    static InsightResults.Suggestions buildSuggestions(Map<?, ?> map) {
        if (map == null) return null;
        var cma = buildList(map, "claude_md_additions",
            m -> new InsightResults.Suggestions.ClaudeMdAddition(str(m, "addition"), str(m, "why"), str(m, "prompt_scaffold")));
        var ftt = buildList(map, "features_to_try",
            m -> new InsightResults.Suggestions.FeatureToTry(str(m, "feature"), str(m, "one_liner"), str(m, "why_for_you"),
                Optional.ofNullable(strNull(m, "example_code"))));
        var up = buildList(map, "usage_patterns",
            m -> new InsightResults.Suggestions.UsagePattern(str(m, "title"), str(m, "suggestion"),
                Optional.ofNullable(strNull(m, "detail")), Optional.ofNullable(strNull(m, "copyable_prompt"))));
        return new InsightResults.Suggestions(cma, ftt, up);
    }

    static InsightResults.OnTheHorizon buildHorizon(Map<?, ?> map) {
        if (map == null) return null;
        var opps = buildList(map, "opportunities",
            m -> new InsightResults.OnTheHorizon.Opportunity(str(m, "title"), str(m, "whats_possible"),
                Optional.ofNullable(strNull(m, "how_to_try")), Optional.ofNullable(strNull(m, "copyable_prompt"))));
        return new InsightResults.OnTheHorizon(str(map, "intro"), opps);
    }

    static InsightResults.FunEnding buildFunEnding(Map<?, ?> map) {
        if (map == null) return null;
        return new InsightResults.FunEnding(str(map, "headline"), str(map, "detail"));
    }

    @FunctionalInterface
    interface Builder<T> { T build(Map<?, ?> m); }

    static <T> List<T> buildList(Map<?, ?> map, String key, Builder<T> builder) {
        var list = map.get(key);
        if (!(list instanceof List<?> items)) return List.of();
        var result = new ArrayList<T>();
        for (var item : items) {
            if (item instanceof Map<?, ?> m) result.add(builder.build(m));
        }
        return result;
    }

    static String str(Map<?, ?> map, String key) {
        var v = map.get(key);
        return v instanceof String s ? s : "";
    }

    static String strNull(Map<?, ?> map, String key) {
        var v = map.get(key);
        return v instanceof String s && !s.isBlank() ? s : null;
    }
}
