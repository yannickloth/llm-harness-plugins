package eu.infolead.llmhp.graph;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public final class PerspectiveExporter {

    private static final int MAX_DIAGRAM_NODES = 40;
    private static final int MAX_COMMUNITY_EDGES = 30;
    private static final List<String> NODE_ANNOTATION_KEYS =
        List.of("constraint", "concern", "todo", "note");
    private static final List<String> EDGE_ANNOTATION_KEYS =
        List.of("contradicts", "generalizes", "consistent_with");

    private PerspectiveExporter() {}

    public record AnnotationMerge(
        Graph graph,
        int elements,
        int properties,
        int edges,
        List<String> warnings
    ) {}

    public static String exportDiagram(Graph graph, String label, int depth) {
        if (label == null || label.isEmpty()) return "Error: label required for diagram";
        var ids = collectNeighborhood(graph, label, depth);
        if (ids.isEmpty()) return "No nodes found for: " + label;
        return mermaid(graph, ids, "knowledge-graph diagram: " + label + " (depth " + depth + ")");
    }

    public static String exportPerspectives(Graph graph, Path outDir, int maxElements) throws IOException {
        var elementsDir = outDir.resolve("elements");
        Files.createDirectories(elementsDir);

        var overall = outDir.resolve("overall-architecture");
        Files.createDirectories(overall);
        writeDescription(overall.resolve("description.md"),
            List.of(
                "perspective: overall-architecture",
                "project: " + graph.project(),
                "generated: build-artifact"
            ),
            "# Overall Architecture\n\n"
                + "Coarse view: communities and the edges between them.\n"
                + "Element-level perspectives live in `elements/`.\n");
        Files.writeString(overall.resolve("diagram.mmd"), communityMermaid(graph));
        Files.writeString(overall.resolve("context.md"), communityContext(graph));

        var selected = selectElements(graph, maxElements);
        int written = 0;
        for (var id : selected) {
            var dir = elementsDir.resolve(dirName(id));
            Files.createDirectories(dir);
            writeElementDir(graph, dir, id);
            written++;
        }
        return "Perspectives written to " + outDir
            + ": overall-architecture + " + written + " element dirs";
    }

    public static AnnotationMerge mergeAnnotations(Graph graph, Path treeDir) throws IOException {
        if (!Files.isDirectory(treeDir)) {
            throw new IOException("perspective tree not found: " + treeDir);
        }
        var nodes = new LinkedHashMap<>(graph.nodes());
        var edges = new ArrayList<>(graph.edges());
        var warnings = new ArrayList<String>();
        int elements = 0;
        int properties = 0;
        int edgesAdded = 0;
        boolean changed = false;

        try (var walk = Files.walk(treeDir)) {
            var files = walk
                .filter(p -> p.getFileName().toString().equals("description.md"))
                .sorted()
                .toList();
            for (var p : files) {
                var fm = parseFrontmatter(Files.readString(p));
                if (fm.isEmpty()) {
                    warnings.add("no frontmatter: " + p);
                    continue;
                }
                var label = fm.getOrDefault("label", "").trim();
                if (label.isEmpty()) continue;
                var node = nodes.get(label);
                if (node == null) {
                    warnings.add("stale label (not in graph): " + label);
                    continue;
                }
                elements++;
                var props = new LinkedHashMap<>(node.properties());
                for (var k : NODE_ANNOTATION_KEYS) {
                    var v = fm.getOrDefault(k, "").trim();
                    if (!v.isEmpty() && !v.equals(props.get(k))) {
                        props.put(k, v);
                        properties++;
                        changed = true;
                    }
                }
                nodes.put(label, new Node(node.id(), node.type(), node.name(),
                    node.file(), node.line(), props));
                for (var k : EDGE_ANNOTATION_KEYS) {
                    for (var target : splitList(fm.getOrDefault(k, ""))) {
                        if (!nodes.containsKey(target)) {
                            warnings.add("dangling " + k + " target for " + label + ": " + target);
                            continue;
                        }
                        var edge = new Edge(label, target, k,
                            new LinkedHashMap<>(Map.of("origin", "archi-scan")));
                        if (!edges.contains(edge)) {
                            edges.add(edge);
                            edgesAdded++;
                            changed = true;
                        }
                    }
                }
            }
        }

        if (!changed) {
            return new AnnotationMerge(graph, elements, 0, 0, warnings);
        }
        var adj = new HashMap<String, List<String>>();
        var rev = new HashMap<String, List<String>>();
        for (var e : edges) {
            adj.computeIfAbsent(e.source(), k -> new ArrayList<>()).add(e.target());
            rev.computeIfAbsent(e.target(), k -> new ArrayList<>()).add(e.source());
        }
        var merged = new Graph(graph.project(), nodes, edges, adj, rev,
            graph.communities(), graph.communitySummaries(), graph.communityHierarchy());
        return new AnnotationMerge(merged, elements, properties, edgesAdded, warnings);
    }

    public static List<String> auditTree(Graph graph, Path treeDir, Path projectRoot) throws IOException {
        if (!Files.isDirectory(treeDir)) {
            throw new IOException("perspective tree not found: " + treeDir);
        }
        var issues = new ArrayList<String>();
        try (var walk = Files.walk(treeDir)) {
            var files = walk
                .filter(p -> p.getFileName().toString().equals("description.md"))
                .sorted()
                .toList();
            for (var p : files) {
                var fm = parseFrontmatter(Files.readString(p));
                if (fm.isEmpty()) {
                    issues.add("no frontmatter: " + p);
                    continue;
                }
                var label = fm.getOrDefault("label", "").trim();
                if (label.isEmpty()) continue;
                if (!graph.nodes().containsKey(label)) {
                    issues.add("stale label (not in graph): " + label
                        + " — dir " + p.getParent().getFileName());
                    continue;
                }
                for (var anchor : splitList(fm.getOrDefault("files", ""))) {
                    var path = anchor.replaceFirst(":\\d+$", "");
                    if (path.isEmpty()) continue;
                    if (!Files.exists(projectRoot.resolve(path))) {
                        issues.add("missing file anchor for " + label + ": " + path);
                    }
                }
                for (var k : EDGE_ANNOTATION_KEYS) {
                    for (var target : splitList(fm.getOrDefault(k, ""))) {
                        if (!graph.nodes().containsKey(target)) {
                            issues.add("dangling " + k + " target for " + label + ": " + target);
                        }
                    }
                }
            }
        }
        return issues;
    }

    private static LinkedHashSet<String> collectNeighborhood(Graph graph, String label, int depth) {
        var start = new LinkedHashSet<String>();
        if (graph.nodes().containsKey(label)) {
            start.add(label);
        } else {
            for (var n : graph.nodes().values()) {
                if (label.equals(n.file()) || label.endsWith("/" + n.file())) start.add(n.id());
            }
        }
        var labels = new LinkedHashSet<>(start);
        for (int i = 0; i < depth; i++) {
            var next = new LinkedHashSet<String>();
            for (var l : labels) {
                next.addAll(graph.neighbors(l));
                next.addAll(graph.reverseNeighbors(l));
            }
            labels.addAll(next);
        }
        return labels;
    }

    static String mermaid(Graph graph, Set<String> ids, String title) {
        var ordered = new ArrayList<String>(ids);
        ordered.sort(Comparator.naturalOrder());
        boolean truncated = ordered.size() > MAX_DIAGRAM_NODES;
        if (truncated) ordered = new ArrayList<>(ordered.subList(0, MAX_DIAGRAM_NODES));
        var index = new LinkedHashMap<String, String>();
        for (int i = 0; i < ordered.size(); i++) index.put(ordered.get(i), "n" + i);

        var sb = new StringBuilder();
        sb.append("%% ").append(title).append("\n");
        sb.append("flowchart LR\n");
        for (var id : ordered) {
            sb.append("  ").append(index.get(id)).append("[\"")
                .append(mermaidEsc(id)).append("\"]\n");
        }
        int edgeCount = 0;
        for (var e : graph.edges()) {
            var s = index.get(e.source());
            var t = index.get(e.target());
            if (s == null || t == null) continue;
            sb.append("  ").append(s).append(" -->|").append(mermaidEsc(e.type()))
                .append("| ").append(t).append("\n");
            edgeCount++;
        }
        if (truncated) {
            sb.append("  %% truncated: ").append(ids.size()).append(" nodes total, showing ")
                .append(MAX_DIAGRAM_NODES).append("\n");
        }
        return sb.toString();
    }

    static String communityMermaid(Graph graph) {
        var comIds = new ArrayList<>(graph.communities().keySet());
        comIds.sort(Comparator.naturalOrder());
        var idx = new LinkedHashMap<String, String>();
        for (int i = 0; i < comIds.size(); i++) idx.put(comIds.get(i), "c" + i);

        var sb = new StringBuilder();
        sb.append("%% knowledge-graph community overview\n");
        sb.append("flowchart LR\n");
        for (var c : comIds) {
            sb.append("  ").append(idx.get(c)).append("[\"").append(c)
                .append(" (").append(graph.communities().get(c).size()).append(")\"]\n");
        }
        var memberCommunity = new HashMap<String, String>();
        for (var e : graph.communities().entrySet()) {
            for (var m : e.getValue()) memberCommunity.put(m, e.getKey());
        }
        var edgeCounts = new LinkedHashMap<String, Integer>();
        for (var ed : graph.edges()) {
            var sc = memberCommunity.get(ed.source());
            var tc = memberCommunity.get(ed.target());
            if (sc == null || tc == null || sc.equals(tc)) continue;
            edgeCounts.merge(sc + "\u0000" + tc, 1, Integer::sum);
        }
        edgeCounts.entrySet().stream()
            .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
            .limit(MAX_COMMUNITY_EDGES)
            .forEach(en -> {
                var parts = en.getKey().split("\u0000", -1);
                sb.append("  ").append(idx.get(parts[0])).append(" -->|")
                    .append(en.getValue()).append("| ").append(idx.get(parts[1])).append("\n");
            });
        return sb.toString();
    }

    static String communityContext(Graph graph) {
        var sb = new StringBuilder();
        sb.append("# Communities\n\n");
        var comIds = new ArrayList<>(graph.communities().keySet());
        comIds.sort(Comparator.naturalOrder());
        for (var c : comIds) {
            sb.append("## ").append(c).append("\n");
            var summary = graph.communitySummaries().getOrDefault(c, "");
            if (!summary.isEmpty()) sb.append(summary).append("\n");
            sb.append("\n");
        }
        return sb.toString();
    }

    private static List<String> selectElements(Graph graph, int maxElements) {
        record Cand(String id, int degree) {}
        var cands = new ArrayList<Cand>();
        for (var id : graph.nodes().keySet()) {
            int deg = graph.adjacency().getOrDefault(id, List.of()).size()
                + graph.reverseAdjacency().getOrDefault(id, List.of()).size();
            if (deg > 0) cands.add(new Cand(id, deg));
        }
        cands.sort(Comparator.comparingInt(Cand::degree).reversed().thenComparing(Cand::id));
        return cands.stream().limit(maxElements).map(Cand::id).toList();
    }

    private static void writeElementDir(Graph graph, Path dir, String id) throws IOException {
        var node = graph.nodes().get(id);
        var community = GraphQueryEngine.findCommunity(graph, id);
        var fm = new ArrayList<String>();
        fm.add("label: " + id);
        fm.add("type: " + node.type());
        fm.add("name: " + node.name());
        if (community != null) fm.add("community: " + community);
        fm.add("files: " + fileAnchors(node));
        for (var k : NODE_ANNOTATION_KEYS) fm.add(k + ": ");
        writeDescription(dir.resolve("description.md"), fm,
            "# " + id + "\n\n"
                + "Describe this element: role, invariants, boundaries.\n"
                + "Keep frontmatter values single-line; prose here is free-form.\n"
                + "Relation lines `contradicts:` / `generalizes:` / `consistent_with:` take\n"
                + "comma-separated labels. Run `merge-annotations` to persist into graph.json.\n");
        Files.writeString(dir.resolve("diagram.mmd"),
            mermaid(graph, collectNeighborhood(graph, id, 1),
                "knowledge-graph diagram: " + id + " (depth 1)"));
        Files.writeString(dir.resolve("context.md"),
            GraphContextBuilder.buildTier1(graph, id, graph.project()));
    }

    private static String fileAnchors(Node node) {
        var parts = new ArrayList<String>();
        if (!node.file().isEmpty()) {
            parts.add(node.line() == null || node.line().isEmpty() || node.line().equals("0")
                ? node.file()
                : node.file() + ":" + node.line());
        }
        var merged = node.property("files");
        if (!merged.isEmpty()) {
            for (var f : merged.split(",")) {
                var t = f.trim();
                if (!t.isEmpty()) parts.add(t);
            }
        }
        return String.join(", ", parts);
    }

    private static void writeDescription(Path file, List<String> frontmatter, String body) throws IOException {
        var sb = new StringBuilder();
        sb.append("---\n");
        for (var line : frontmatter) sb.append(line).append("\n");
        sb.append("---\n\n");
        sb.append(body);
        Files.writeString(file, sb.toString());
    }

    static Map<String, String> parseFrontmatter(String content) {
        var lines = content.split("\n", -1);
        if (lines.length < 2 || !lines[0].trim().equals("---")) return Map.of();
        int end = -1;
        for (int i = 1; i < lines.length; i++) {
            if (lines[i].trim().equals("---")) {
                end = i;
                break;
            }
        }
        if (end < 0) return Map.of();
        var map = new LinkedHashMap<String, String>();
        for (int i = 1; i < end; i++) {
            var line = lines[i];
            int c = line.indexOf(':');
            if (c <= 0) continue;
            map.put(line.substring(0, c).trim(), line.substring(c + 1).trim());
        }
        return map;
    }

    private static List<String> splitList(String value) {
        var out = new ArrayList<String>();
        if (value == null) return out;
        for (var part : value.split(",")) {
            var t = part.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    private static String dirName(String id) {
        return id.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static String mermaidEsc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "'").replace("\n", " ");
    }
}
