package eu.infolead.llmhp.memory.types;

import java.util.*;

public record Entry(
    String name, String description, String type, Optional<String> subtype,
    String who, String context, String confidence, Optional<String> modified,
    Optional<Integer> version, Optional<Integer> reads, Optional<String> lastRead,
    Optional<Boolean> guard, Optional<String> guardTrigger, Optional<String> contradicts,
    Optional<String> sync, Optional<String> modelTier, Optional<String> model,
    Optional<String> language, Optional<String> tone, Optional<String> expires,
    Optional<String> status, Optional<Integer> recalledFor,
    Optional<Integer> appliedSuccessfully, Optional<Integer> appliedIncorrectly,
    Optional<String> contradictedBy, Optional<String> scope,
    Optional<List<String>> gitRefs, Optional<List<String>> impactCommits,
    Optional<Boolean> impactVerified, Optional<Boolean> peerReview
) {
    public static Entry fromFrontmatter(Map<String, String> fm) {
        return new Entry(
            fm.getOrDefault("name", ""),
            fm.getOrDefault("description", ""),
            fm.getOrDefault("type", ""),
            Optional.ofNullable(fm.get("subtype")),
            fm.getOrDefault("who", ""),
            fm.getOrDefault("context", ""),
            fm.getOrDefault("confidence", "medium"),
            Optional.ofNullable(fm.get("modified")),
            parseOptionalInt(fm.get("version")),
            parseOptionalInt(fm.get("reads")),
            Optional.ofNullable(fm.get("last_read")),
            parseOptionalBool(fm.get("guard")),
            Optional.ofNullable(fm.get("guard_trigger")),
            Optional.ofNullable(fm.get("contradicts")),
            Optional.ofNullable(fm.get("sync")),
            Optional.ofNullable(fm.get("model_tier")),
            Optional.ofNullable(fm.get("model")),
            Optional.ofNullable(fm.get("language")),
            Optional.ofNullable(fm.get("tone")),
            Optional.ofNullable(fm.get("expires")),
            Optional.ofNullable(fm.get("status")),
            parseOptionalInt(fm.get("recalled_for")),
            parseOptionalInt(fm.get("applied_successfully")),
            parseOptionalInt(fm.get("applied_incorrectly")),
            Optional.ofNullable(fm.get("contradicted_by")),
            Optional.ofNullable(fm.get("scope")),
            parseOptionalStringList(fm.get("git_refs")),
            parseOptionalStringList(fm.get("impact_commits")),
            parseOptionalBool(fm.get("impact_verified")),
            parseOptionalBool(fm.get("peer_review"))
        );
    }

    public Map<String, Object> toMap() {
        var map = new LinkedHashMap<String, Object>();
        map.put("name", name); map.put("description", description);
        map.put("type", type); subtype.ifPresent(v -> map.put("subtype", v));
        map.put("who", who); map.put("context", context);
        map.put("confidence", confidence); modified.ifPresent(v -> map.put("modified", v));
        version.ifPresent(v -> map.put("version", v));
        reads.ifPresent(v -> map.put("reads", v));
        lastRead.ifPresent(v -> map.put("last_read", v));
        guard.ifPresent(v -> map.put("guard", v));
        guardTrigger.ifPresent(v -> map.put("guard_trigger", v));
        contradicts.ifPresent(v -> map.put("contradicts", v));
        sync.ifPresent(v -> map.put("sync", v));
        modelTier.ifPresent(v -> map.put("model_tier", v));
        model.ifPresent(v -> map.put("model", v));
        language.ifPresent(v -> map.put("language", v));
        tone.ifPresent(v -> map.put("tone", v));
        expires.ifPresent(v -> map.put("expires", v));
        status.ifPresent(v -> map.put("status", v));
        recalledFor.ifPresent(v -> map.put("recalled_for", v));
        appliedSuccessfully.ifPresent(v -> map.put("applied_successfully", v));
        appliedIncorrectly.ifPresent(v -> map.put("applied_incorrectly", v));
        contradictedBy.ifPresent(v -> map.put("contradicted_by", v));
        scope.ifPresent(v -> map.put("scope", v));
        gitRefs.ifPresent(v -> map.put("git_refs", v));
        impactCommits.ifPresent(v -> map.put("impact_commits", v));
        impactVerified.ifPresent(v -> map.put("impact_verified", v));
        peerReview.ifPresent(v -> map.put("peer_review", v));
        return map;
    }

    public static String toYamlFrontmatter(Entry e) {
        var sb = new StringBuilder();
        sb.append("---\n");
        for (var entry : e.toMap().entrySet()) {
            var val = entry.getValue();
            if (val instanceof List<?> list) {
                sb.append("%s:\n".formatted(entry.getKey()));
                for (var item : list) sb.append("  - %s\n".formatted(item));
            } else {
                sb.append("%s: %s\n".formatted(entry.getKey(), val));
            }
        }
        sb.append("---");
        return sb.toString();
    }

    private static Optional<Integer> parseOptionalInt(String s) {
        if (s == null || s.isBlank()) return Optional.empty();
        try { return Optional.of(Integer.parseInt(s)); } catch (NumberFormatException e) { return Optional.empty(); }
    }
    private static Optional<Boolean> parseOptionalBool(String s) {
        if (s == null || s.isBlank()) return Optional.empty();
        return Optional.of("true".equalsIgnoreCase(s));
    }
    private static Optional<List<String>> parseOptionalStringList(String s) {
        if (s == null || s.isBlank()) return Optional.empty();
        return Optional.of(List.of(s.split(",\\s*")));
    }
}
