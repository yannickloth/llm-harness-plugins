package eu.infolead.llmhp.graph;

import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public final class GraphRater {

    private GraphRater() {}

    public record RelevanceResult(
        List<CommunityScore> rankedCommunities,
        List<String> selectedLabels
    ) {}

    public record CommunityScore(String communityId, double score, String summary, int memberCount) {}

    public static RelevanceResult rateRelevance(Graph graph, String agentTask, int topK) {
        var taskTokens = tokenize(agentTask.toLowerCase());

        var scores = new ArrayList<CommunityScore>();
        for (var e : graph.communities().entrySet()) {
            var summary = graph.communitySummaries().getOrDefault(e.getKey(), "");
            var summaryTokens = tokenize(summary.toLowerCase());

            var score = computeRelevance(taskTokens, summaryTokens, e.getValue(), graph);
            if (score > 0) {
                scores.add(new CommunityScore(e.getKey(), score, summary, e.getValue().size()));
            }
        }

        scores.sort((a, b) -> Double.compare(b.score(), a.score()));
        var top = scores.subList(0, Math.min(topK, scores.size()));
        var selectedLabels = new ArrayList<String>();
        for (var s : top) {
            var members = graph.communities().get(s.communityId());
            if (members != null) selectedLabels.addAll(members);
        }

        return new RelevanceResult(top, new ArrayList<>(new LinkedHashSet<>(selectedLabels)));
    }

    public static String formatRating(Graph graph, RelevanceResult result, String agentTask) {
        var sb = new StringBuilder();
        sb.append("RATED COMMUNITIES for: \"").append(agentTask).append("\"\n\n");
        sb.append(String.format("Top %d of %d communities:\n\n", result.rankedCommunities().size(),
            graph.communities().size()));

        int rank = 1;
        for (var cs : result.rankedCommunities()) {
            sb.append(String.format("%2d. [%.3f] %s (%d members)\n",
                rank++, cs.score(), cs.communityId(), cs.memberCount()));
            var summary = cs.summary();
            if (!summary.isEmpty()) {
                var firstLine = summary.lines().findFirst().orElse("");
                sb.append("    ").append(firstLine).append("\n");
            }
        }

        sb.append(String.format("\nTotal selected labels: %d\n", result.selectedLabels().size()));
        return sb.toString();
    }

    private static double computeRelevance(List<String> taskTokens, List<String> summaryTokens,
                                            List<String> members, Graph graph) {
        double score = 0;

        for (var tt : taskTokens) {
            if (tt.length() < 3) continue;
            for (var st : summaryTokens) {
                if (st.equals(tt)) score += 1.0;
                else if (st.startsWith(tt) || tt.startsWith(st)) score += 0.5;
            }
        }

        for (var member : members) {
            var memberLower = member.toLowerCase();
            for (var tt : taskTokens) {
                if (tt.length() < 3) continue;
                if (memberLower.contains(tt)) score += 2.0;
            }
        }

        score *= Math.log(members.size() + 1);
        return score;
    }

    private static List<String> tokenize(String text) {
        var tokens = new ArrayList<String>();
        var word = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            var c = text.charAt(i);
            if (Character.isLetterOrDigit(c) || c == '-' || c == '_') {
                word.append(Character.toLowerCase(c));
            } else {
                if (!word.isEmpty()) {
                    tokens.add(word.toString());
                    word.setLength(0);
                }
            }
        }
        if (!word.isEmpty()) tokens.add(word.toString());
        return tokens;
    }
}
