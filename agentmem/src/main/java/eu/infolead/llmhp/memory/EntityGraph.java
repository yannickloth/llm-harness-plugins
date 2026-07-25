package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class EntityGraph {

    public record GraphEntry(String entity, Set<String> files, Map<String, Integer> relatedTo) {}

    public static void build(Path memDir) throws IOException {
        var adjacency = new LinkedHashMap<String, Map<String, Integer>>();
        var entityIndex = EntityIndex.readIndex(memDir.resolve(".entities.json"));

        for (var e : entityIndex.entrySet()) {
            var filenames = new ArrayList<>(e.getValue());
            for (int i = 0; i < filenames.size(); i++) {
                for (int j = i + 1; j < filenames.size(); j++) {
                    addEdge(adjacency, filenames.get(i), filenames.get(j));
                }
            }
        }

        var sb = new StringBuilder("{\n");
        var first = true;
        for (var e : adjacency.entrySet()) {
            if (!first) sb.append(",\n");
            first = false;
            sb.append("  \"%s\": {".formatted(esc(e.getKey())));
            sb.append("\"related_to\": {");
            var firstRel = true;
            for (var rel : e.getValue().entrySet()) {
                if (!firstRel) sb.append(", ");
                firstRel = false;
                sb.append("\"%s\": %d".formatted(esc(rel.getKey()), rel.getValue()));
            }
            sb.append("}}");
        }
        sb.append("\n}\n");
        Files.writeString(memDir.resolve(".entities-graph.json"), sb.toString());
        System.out.printf("Built entity graph: %d nodes%n", adjacency.size());
    }

    public static String expand(Path memDir, String entity) throws IOException {
        var graphFile = memDir.resolve(".entities-graph.json");
        if (!Files.exists(graphFile)) return "NONE";
        var raw = Files.readString(graphFile);
        if (!raw.contains("\"" + esc(entity) + "\"")) return "NONE";
        var index = EntityIndex.readIndex(memDir.resolve(".entities.json"));
        var files = index.get(entity);
        return files != null ? String.join(",", files) : "NONE";
    }

    private static void addEdge(Map<String, Map<String, Integer>> adj, String a, String b) {
        if (a.equals(b)) return;
        adj.computeIfAbsent(a, k -> new HashMap<>()).merge(b, 1, Integer::sum);
        adj.computeIfAbsent(b, k -> new HashMap<>()).merge(a, 1, Integer::sum);
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
