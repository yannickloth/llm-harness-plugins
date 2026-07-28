package eu.infolead.llmhp.graph.types;

import java.util.*;

public record Graph(
    String project,
    Map<String, Node> nodes,
    List<Edge> edges,
    Map<String, List<String>> adjacency,
    Map<String, List<String>> reverseAdjacency,
    Map<String, List<String>> communities,
    Map<String, String> communitySummaries,
    Map<String, List<String>> communityHierarchy
) {
    public Set<String> neighbors(String nodeId) {
        return new HashSet<>(adjacency.getOrDefault(nodeId, List.of()));
    }

    public Set<String> reverseNeighbors(String nodeId) {
        return new HashSet<>(reverseAdjacency.getOrDefault(nodeId, List.of()));
    }

    public Set<String> transitiveClosure(String startId) {
        var visited = new LinkedHashSet<String>();
        var queue = new ArrayDeque<String>();
        queue.add(startId);
        while (!queue.isEmpty()) {
            var id = queue.poll();
            if (!visited.add(id)) continue;
            for (var n : adjacency.getOrDefault(id, List.of())) {
                if (!visited.contains(n)) queue.add(n);
            }
        }
        return visited;
    }

    public Set<String> reverseTransitiveClosure(String startId) {
        var visited = new LinkedHashSet<String>();
        var queue = new ArrayDeque<String>();
        queue.add(startId);
        while (!queue.isEmpty()) {
            var id = queue.poll();
            if (!visited.add(id)) continue;
            for (var n : reverseAdjacency.getOrDefault(id, List.of())) {
                if (!visited.contains(n)) queue.add(n);
            }
        }
        return visited;
    }

    public List<String> topologicalSort(Set<String> scopeNodeIds) {
        var inDegree = new HashMap<String, Integer>();
        for (var n : scopeNodeIds) {
            inDegree.putIfAbsent(n, 0);
            for (var t : adjacency.getOrDefault(n, List.of())) {
                if (scopeNodeIds.contains(t)) {
                    inDegree.merge(t, 1, Integer::sum);
                    inDegree.putIfAbsent(n, 0);
                }
            }
        }
        var queue = new ArrayDeque<String>();
        for (var e : inDegree.entrySet()) {
            if (e.getValue() == 0) queue.add(e.getKey());
        }
        var result = new ArrayList<String>();
        while (!queue.isEmpty()) {
            var n = queue.poll();
            result.add(n);
            for (var t : adjacency.getOrDefault(n, List.of())) {
                if (!scopeNodeIds.contains(t)) continue;
                var deg = inDegree.merge(t, -1, Integer::sum);
                if (deg == 0) queue.add(t);
            }
        }
        if (result.size() != scopeNodeIds.size()) result.add("WARNING: cycle detected, partial order only");
        return result;
    }

    public List<List<String>> findCycles() {
        var cycles = new ArrayList<List<String>>();
        for (var node : nodes.keySet()) {
            var path = new ArrayList<String>();
            var visited = new HashSet<String>();
            findCyclesDfs(node, node, path, visited, cycles, 50);
        }
        return cycles;
    }

    private void findCyclesDfs(String start, String current, List<String> path,
            Set<String> visited, List<List<String>> cycles, int maxDepth) {
        if (path.size() > maxDepth) return;
        path.add(current);
        visited.add(current);
        for (var next : adjacency.getOrDefault(current, List.of())) {
            if (next.equals(start) && path.size() > 2) {
                cycles.add(new ArrayList<>(path));
            } else if (!visited.contains(next)) {
                findCyclesDfs(start, next, path, visited, cycles, maxDepth);
            }
        }
        path.removeLast();
        visited.remove(current);
    }
}
