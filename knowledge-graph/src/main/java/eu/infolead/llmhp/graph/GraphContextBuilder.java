package eu.infolead.llmhp.graph;

import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public final class GraphContextBuilder {

    private static final int MAX_CONTEXT_TOKENS = 4000;
    private static final int TC_MAX_DEPTH = 10;

    private GraphContextBuilder() {}

    public static String buildTier1(Graph graph, String label, String project) {
        var sb = new StringBuilder();
        var node = graph.nodes().get(label);
        if (node == null) return "Label not found in graph: " + label;

        sb.append(String.format("GRAPH CONTEXT for %s [%s]\n", label, project));

        var hCom = findCommunity(graph, label);
        if (hCom != null) {
            sb.append(String.format("  Community: %s (L2)\n", hCom));
            var summary = graph.communitySummaries().get(hCom);
            if (summary != null && !summary.isEmpty()) {
                sb.append("  Summary: \"").append(summary.lines().findFirst().orElse("")).append("\"\n");
            }
        }

        var allDeps = graph.reverseTransitiveClosure(label, TC_MAX_DEPTH);
        allDeps.remove(label);
        var sharedDeps = new ArrayList<String>();
        var localDeps = new ArrayList<String>();

        for (var dep : allDeps) {
            var depNode = graph.nodes().get(dep);
            if (depNode == null) continue;
            var usageCount = countUsages(graph, dep);
            if (usageCount > 5) sharedDeps.add(dep);
            else localDeps.add(dep);
        }

        sb.append("  Transitive dependencies (").append(sharedDeps.size() + localDeps.size()).append("):\n");
        if (!sharedDeps.isEmpty()) {
            sb.append("    [shared] ");
            sb.append(String.join(", ", sharedDeps.subList(0, Math.min(15, sharedDeps.size()))));
            sb.append("\n");
        }
        if (!localDeps.isEmpty()) {
            sb.append("    [local]  ");
            sb.append(String.join(", ", localDeps.subList(0, Math.min(15, localDeps.size()))));
            sb.append("\n");
        }

        var dependents = graph.transitiveClosure(label, TC_MAX_DEPTH);
        dependents.remove(label);
        if (!dependents.isEmpty()) {
            sb.append("  Used by (").append(dependents.size()).append(" nodes): ");
            var depList = new ArrayList<>(dependents);
            sb.append(String.join(", ", depList.subList(0, Math.min(10, depList.size()))));
            sb.append("\n");
        }

        var ctx = sb.toString();
        if (ctx.length() > MAX_CONTEXT_TOKENS * 4) {
            ctx = ctx.substring(0, MAX_CONTEXT_TOKENS * 4) + "\n... [truncated]";
        }
        return ctx;
    }

    public static String buildTier2(Graph graph, String label, String project) {
        var sb = new StringBuilder();
        sb.append(buildTier1(graph, label, project)).append("\n");

        var contradictions = new ArrayList<String>();
        for (var e : graph.edges()) {
            if (e.type().equals("contradicts") &&
                (e.source().equals(label) || e.target().equals(label))) {
                var other = e.source().equals(label) ? e.target() : e.source();
                contradictions.add(other);
            }
        }

        if (!contradictions.isEmpty()) {
            sb.append("  Contradictions detected:\n");
            for (var c : contradictions) {
                sb.append("    ").append(label).append(" ↔ ").append(c).append("\n");
            }
        } else {
            sb.append("  Contradictions: NONE — consistent at this level\n");
        }

        var ctx = sb.toString();
        if (ctx.length() > MAX_CONTEXT_TOKENS * 4) {
            ctx = ctx.substring(0, MAX_CONTEXT_TOKENS * 4) + "\n... [truncated]";
        }
        return ctx;
    }

    public static String buildScopeContext(Graph graph, String filePath) {
        var labels = findLabelsInFile(graph, filePath);
        if (labels.isEmpty()) return "";

        var sb = new StringBuilder();
        sb.append("GRAPH SCOPE: ").append(filePath).append("\n");
        sb.append("Entities in this file:\n");
        for (var label : labels) {
            var node = graph.nodes().get(label);
            if (node != null) {
                sb.append(String.format("  [%s] %s — %s\n", node.type(), label, node.name()));
            }
        }
        return sb.toString();
    }

    public static String buildProjectOverview(Graph graph) {
        var sb = new StringBuilder();
        sb.append("PROJECT GRAPH OVERVIEW [").append(graph.project()).append("]\n");
        sb.append(String.format("  Nodes: %d\n", graph.nodes().size()));
        sb.append(String.format("  Edges: %d\n", graph.edges().size()));

        var typeCounts = new LinkedHashMap<String, Integer>();
        for (var n : graph.nodes().values()) {
            typeCounts.merge(n.type(), 1, Integer::sum);
        }
        sb.append("  Node types:\n");
        for (var t : typeCounts.entrySet()) {
            sb.append(String.format("    %s: %d\n", t.getKey(), t.getValue()));
        }

        var edgeCounts = new LinkedHashMap<String, Integer>();
        for (var e : graph.edges()) {
            edgeCounts.merge(e.type(), 1, Integer::sum);
        }
        sb.append("  Edge types:\n");
        for (var e : edgeCounts.entrySet()) {
            sb.append(String.format("    %s: %d\n", e.getKey(), e.getValue()));
        }

        return sb.toString();
    }

    private static String findCommunity(Graph graph, String label) {
        for (var e : graph.communities().entrySet()) {
            if (e.getValue().contains(label)) return e.getKey();
        }
        return null;
    }

    private static int countUsages(Graph graph, String label) {
        var count = 0;
        for (var e : graph.edges()) {
            if (e.type().equals("depends_on") && e.target().equals(label)) count++;
        }
        return count;
    }

    private static List<String> findLabelsInFile(Graph graph, String filePath) {
        var labels = new ArrayList<String>();
        for (var n : graph.nodes().values()) {
            if (n.file().equals(filePath) || n.file().endsWith(filePath)) {
                labels.add(n.id());
            }
        }
        return labels;
    }
}
