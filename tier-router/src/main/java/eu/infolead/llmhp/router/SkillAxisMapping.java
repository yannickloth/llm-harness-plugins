package eu.infolead.llmhp.router;

record SkillAxisMapping(
    SkillAxis axis,
    String model,
    String initial,
    MatchType matchType,
    String note
) {
    enum MatchType { direct, generalist }
}
