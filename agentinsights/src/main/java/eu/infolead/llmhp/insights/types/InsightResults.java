package eu.infolead.llmhp.insights.types;

import java.util.*;

public record InsightResults(
    Optional<AtAGlance> atAGlance,
    Optional<ProjectAreas> projectAreas,
    Optional<InteractionStyle> interactionStyle,
    Optional<WhatWorks> whatWorks,
    Optional<FrictionAnalysis> frictionAnalysis,
    Optional<Suggestions> suggestions,
    Optional<OnTheHorizon> onTheHorizon,
    Optional<FunEnding> funEnding
) {
    public record AtAGlance(String whatsWorking, String whatsHindering,
                            String quickWins, String ambitiousWorkflows) {}
    public record ProjectAreas(List<Area> areas) {
        public record Area(String name, int sessionCount, String description) {}
    }
    public record InteractionStyle(String narrative, String keyPattern) {}
    public record WhatWorks(String intro, List<ImpressiveWorkflow> impressiveWorkflows) {
        public record ImpressiveWorkflow(String title, String description) {}
    }
    public record FrictionAnalysis(String intro, List<FrictionCategory> categories) {
        public record FrictionCategory(String category, String description, Optional<List<String>> examples) {}
    }
    public record Suggestions(
        List<ClaudeMdAddition> claudeMdAdditions,
        List<FeatureToTry> featuresToTry,
        List<UsagePattern> usagePatterns
    ) {
        public record ClaudeMdAddition(String addition, String why, String promptScaffold) {}
        public record FeatureToTry(String feature, String oneLiner, String whyForYou, Optional<String> exampleCode) {}
        public record UsagePattern(String title, String suggestion, Optional<String> detail, Optional<String> copyablePrompt) {}
    }
    public record OnTheHorizon(String intro, List<Opportunity> opportunities) {
        public record Opportunity(String title, String whatsPossible, Optional<String> howToTry, Optional<String> copyablePrompt) {}
    }
    public record FunEnding(String headline, String detail) {}
}
