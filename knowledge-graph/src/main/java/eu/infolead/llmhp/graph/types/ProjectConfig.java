package eu.infolead.llmhp.graph.types;

import java.util.*;

public record ProjectConfig(
    String project,
    List<LabelRule> labelRules,
    List<EdgeRule> edgeRules,
    Map<String, List<String>> namingConventions,
    List<String> structuralPrefixes
) {
    public record LabelRule(
        String regex,
        String type,
        Map<String, String> defaults
    ) {}

    public record EdgeRule(
        String fromPrefix,
        String toPrefix,
        String edgeType,
        String description
    ) {}
}
