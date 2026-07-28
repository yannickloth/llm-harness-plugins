package eu.infolead.llmhp.graph;

import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public final class CommunityDetector {

    private CommunityDetector() {}

    public record CommunityResult(
        Map<String, List<String>> communities,
        Map<String, String> summaries,
        Map<String, List<String>> hierarchy
    ) {}

    public static CommunityResult detect(Graph graph, long seed) {
        var adj = buildUndirectedAdjacency(graph);
        var leiden = new LeidenAlgorithm(adj, seed);
        var partition = leiden.run();

        var communities = new LinkedHashMap<String, List<String>>();
        for (var e : partition.entrySet()) {
            communities.computeIfAbsent(e.getValue(), k -> new ArrayList<>()).add(e.getKey());
        }

        var hierarchy = buildHierarchy(communities);
        var summaries = generateSummaries(graph, communities);

        return new CommunityResult(communities, summaries, hierarchy);
    }

    private static Map<String, Set<String>> buildUndirectedAdjacency(Graph graph) {
        var adj = new LinkedHashMap<String, Set<String>>();
        for (var e : graph.edges()) {
            if (!e.type().equals("depends_on")) continue;
            adj.computeIfAbsent(e.source(), k -> new LinkedHashSet<>()).add(e.target());
            adj.computeIfAbsent(e.target(), k -> new LinkedHashSet<>()).add(e.source());
        }
        for (var node : graph.nodes().keySet()) {
            adj.putIfAbsent(node, new LinkedHashSet<>());
        }
        return adj;
    }

    private static Map<String, List<String>> buildHierarchy(Map<String, List<String>> communities) {
        var hierarchy = new LinkedHashMap<String, List<String>>();
        for (var e : communities.entrySet()) {
            var comId = e.getKey();
            var parts = comId.split("-");
            var levels = new ArrayList<String>();
            var accum = new StringBuilder();
            for (int i = 0; i < Math.min(parts.length, 5); i++) {
                if (!accum.isEmpty()) accum.append("-");
                accum.append(parts[i]);
                levels.add(accum.toString());
            }
            if (!levels.isEmpty()) {
                var top = levels.removeLast();
                hierarchy.put(comId, levels);
            }
        }
        return hierarchy;
    }

    private static Map<String, String> generateSummaries(Graph graph, Map<String, List<String>> communities) {
        var summaries = new LinkedHashMap<String, String>();
        for (var e : communities.entrySet()) {
            var members = e.getValue();
            if (members.size() < 3) continue;

            var sb = new StringBuilder();
            sb.append("Community %s: %d entities\n".formatted(e.getKey(), members.size()));
            sb.append("Contains: ");
            var first = true;
            for (var m : members) {
                if (!first) sb.append(", ");
                first = false;
                sb.append(m);
            }
            sb.append("\n");

            var types = new LinkedHashMap<String, Integer>();
            for (var m : members) {
                var node = graph.nodes().get(m);
                if (node != null) types.merge(node.type(), 1, Integer::sum);
            }
            sb.append("Composition: ");
            first = true;
            for (var t : types.entrySet()) {
                if (!first) sb.append(", ");
                first = false;
                sb.append(t.getValue()).append(" ").append(t.getKey());
                if (t.getValue() > 1) sb.append("s");
            }
            sb.append("\n");

            var internal = 0;
            var external = 0;
            for (var m : members) {
                for (var target : graph.adjacency().getOrDefault(m, List.of())) {
                    if (members.contains(target)) internal++;
                    else external++;
                }
            }
            sb.append("Edges: %d internal, %d external\n".formatted(internal, external));

            summaries.put(e.getKey(), sb.toString());
        }
        return summaries;
    }

    static class LeidenAlgorithm {
        private final Map<String, Set<String>> adj;
        private final long seed;
        private final Random rng;

        LeidenAlgorithm(Map<String, Set<String>> adj, long seed) {
            this.adj = adj;
            this.seed = seed;
            this.rng = new Random(seed);
        }

        Map<String, String> run() {
            var partition = new LinkedHashMap<String, String>();
            for (var node : adj.keySet()) partition.put(node, node);

            boolean improved;
            int iter = 0;
            do {
                improved = false;
                var nodes = new ArrayList<>(adj.keySet());
                Collections.shuffle(nodes, rng);

                for (var node : nodes) {
                    var bestCommunity = partition.get(node);
                    double bestDelta = 0;
                    var neighborComs = new LinkedHashMap<String, Integer>();

                    for (var neighbor : adj.getOrDefault(node, Set.of())) {
                        var com = partition.get(neighbor);
                        if (com == null || com.equals(bestCommunity)) continue;
                        neighborComs.merge(com, 1, Integer::sum);
                    }

                    for (var e : neighborComs.entrySet()) {
                        var delta = modularityDelta(node, bestCommunity, e.getKey(), partition);
                        if (delta > bestDelta) {
                            bestDelta = delta;
                            bestCommunity = e.getKey();
                        }
                    }

                    if (!bestCommunity.equals(partition.get(node))) {
                        partition.put(node, bestCommunity);
                        improved = true;
                    }
                }
                iter++;
            } while (improved && iter < 50);

            return partition;
        }

        private double modularityDelta(String node, String currentCom, String targetCom,
                                        Map<String, String> partition) {
            var k_i = adj.getOrDefault(node, Set.of()).size();
            var totalEdges = adj.values().stream().mapToInt(Set::size).sum() / 2;

            var sigma_cur = 0;
            var sigma_tar = 0;
            for (var neighbor : adj.getOrDefault(node, Set.of())) {
                if (partition.get(neighbor).equals(currentCom)) sigma_cur++;
                if (partition.get(neighbor).equals(targetCom)) sigma_tar++;
            }

            var total_cur = 0;
            var total_tar = 0;
            for (var e : partition.entrySet()) {
                if (e.getValue().equals(currentCom)) total_cur += adj.getOrDefault(e.getKey(), Set.of()).size();
                if (e.getValue().equals(targetCom)) total_tar += adj.getOrDefault(e.getKey(), Set.of()).size();
            }

            double expected_cur = (double) k_i * total_cur / (2.0 * totalEdges);
            double expected_tar = (double) k_i * total_tar / (2.0 * totalEdges);

            double moveDelta = (sigma_tar - sigma_cur) - (expected_tar - expected_cur);
            return moveDelta / (2.0 * totalEdges);
        }
    }
}
