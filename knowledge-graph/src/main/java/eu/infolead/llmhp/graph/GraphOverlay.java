package eu.infolead.llmhp.graph;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public final class GraphOverlay {

    private static final String DEFAULT_ORIGIN = "llm";

    private GraphOverlay() {}

    public record Overlay(String origin, Map<String, Node> nodes, List<Edge> edges) {}

    public record MergeResult(
        Graph graph,
        int nodesAdded,
        int nodesMerged,
        int edgesAdded,
        List<String> warnings,
        Map<String, Integer> origins
    ) {}

    public static Overlay load(Path file) throws IOException {
        if (!Files.exists(file)) throw new IOException("overlay not found: " + file);
        return parse(Files.readString(file));
    }

    public static Overlay parse(String json) {
        var root = new GraphQueryEngine.JsonParser(GraphQueryEngine.tokenize(json)).parseObject();
        var declaredOrigin = root.optString("origin", "");
        var origin = declaredOrigin.isBlank() ? DEFAULT_ORIGIN : declaredOrigin;

        var nodes = new LinkedHashMap<String, Node>();
        for (var n : root.getArray("nodes")) {
            var obj = n.asObject();
            var props = new LinkedHashMap<String, String>();
            var propsObj = obj.getObject("properties");
            for (var k : propsObj.keys()) props.put(k, propsObj.getString(k));
            var node = new Node(
                obj.getString("id"),
                obj.getString("type"),
                obj.optString("name", ""),
                obj.optString("file", ""),
                obj.optString("line", "0"),
                props);
            nodes.put(node.id(), node);
        }

        var edges = new ArrayList<Edge>();
        for (var e : root.getArray("edges")) {
            var obj = e.asObject();
            var props = new LinkedHashMap<String, String>();
            var propsObj = obj.getObject("properties");
            for (var k : propsObj.keys()) props.put(k, propsObj.getString(k));
            edges.add(new Edge(
                obj.getString("source"),
                obj.getString("target"),
                obj.getString("type"),
                props));
        }
        return new Overlay(origin, nodes, edges);
    }

    public static List<String> validate(Overlay overlay) {
        var issues = new ArrayList<String>();
        for (var n : overlay.nodes().values()) {
            if (n.id().isBlank()) issues.add("Empty node ID");
            if (n.type().isBlank()) issues.add("Empty type for node: " + n.id());
            if (n.id().startsWith(":")) issues.add("Malformed node ID: " + n.id());
        }
        for (var e : overlay.edges()) {
            if (e.source().isBlank() || e.target().isBlank()) {
                issues.add("Edge with blank endpoint: " + e.source() + " -> " + e.target());
            }
            if (e.type().isBlank()) {
                issues.add("Edge with blank type: " + e.source() + " -> " + e.target());
            }
            if (e.source().equals(e.target())) {
                issues.add("Self-loop edge: " + e.source());
            }
        }
        return issues;
    }

    public static MergeResult merge(Graph base, Overlay overlay, String originOverride) {
        var origin = originOverride != null && !originOverride.isBlank() ? originOverride : overlay.origin();
        var nodes = new LinkedHashMap<>(base.nodes());
        var edges = new ArrayList<>(base.edges());
        var warnings = new ArrayList<String>();
        int nodesAdded = 0;
        int nodesMerged = 0;
        int edgesAdded = 0;

        for (var ov : overlay.nodes().values()) {
            if (ov.id().isBlank()) {
                warnings.add("skipped overlay node with blank id");
                continue;
            }
            var existing = nodes.get(ov.id());
            if (existing == null) {
                var props = new LinkedHashMap<>(ov.properties());
                props.putIfAbsent("origin", origin);
                var type = ov.type().isEmpty() ? defaultType(ov.id()) : ov.type();
                var line = ov.line().isEmpty() ? "0" : ov.line();
                nodes.put(ov.id(), new Node(ov.id(), type, ov.name(), ov.file(), line, props));
                nodesAdded++;
            } else {
                var props = new LinkedHashMap<>(existing.properties());
                props.putAll(ov.properties());
                props.putIfAbsent("origin", origin);
                var type = ov.type().isEmpty() ? existing.type() : ov.type();
                var name = ov.name().isEmpty() ? existing.name() : ov.name();
                var file = ov.file().isEmpty() ? existing.file() : ov.file();
                var line = ov.line().isEmpty() || ov.line().equals("0") ? existing.line() : ov.line();
                nodes.put(ov.id(), new Node(existing.id(), type, name, file, line, props));
                nodesMerged++;
            }
        }

        var edgeIndex = new LinkedHashMap<String, Integer>();
        for (int i = 0; i < edges.size(); i++) edgeIndex.putIfAbsent(edgeKey(edges.get(i)), i);

        for (var e : overlay.edges()) {
            if (e.source().isBlank() || e.target().isBlank() || e.type().isBlank()) {
                warnings.add("skipped overlay edge with blank endpoint/type: "
                    + e.source() + " -[" + e.type() + "]-> " + e.target());
                continue;
            }
            for (var endpoint : List.of(e.source(), e.target())) {
                if (!nodes.containsKey(endpoint)) {
                    var props = new LinkedHashMap<String, String>();
                    props.put("origin", origin);
                    props.put("auto-created", "true");
                    nodes.put(endpoint, new Node(endpoint, defaultType(endpoint),
                        endpoint, "", "0", props));
                    nodesAdded++;
                    warnings.add("auto-created node for dangling edge endpoint: " + endpoint);
                }
            }
            var props = new LinkedHashMap<>(e.properties());
            props.putIfAbsent("origin", origin);
            var key = edgeKey(e);
            var idx = edgeIndex.get(key);
            if (idx == null) {
                edges.add(new Edge(e.source(), e.target(), e.type(), props));
                edgeIndex.put(key, edges.size() - 1);
                edgesAdded++;
            } else {
                var old = edges.get(idx);
                var merged = new LinkedHashMap<>(old.properties());
                merged.putAll(e.properties());
                merged.putIfAbsent("origin", origin);
                edges.set(idx, new Edge(old.source(), old.target(), old.type(), merged));
            }
        }

        var adj = new HashMap<String, List<String>>();
        var rev = new HashMap<String, List<String>>();
        for (var e : edges) {
            adj.computeIfAbsent(e.source(), k -> new ArrayList<>()).add(e.target());
            rev.computeIfAbsent(e.target(), k -> new ArrayList<>()).add(e.source());
        }
        var mergedGraph = new Graph(base.project(), nodes, edges, adj, rev,
            base.communities(), base.communitySummaries(), base.communityHierarchy());

        var origins = new TreeMap<String, Integer>();
        for (var n : nodes.values()) origins.merge(n.property("origin"), 1, Integer::sum);
        for (var e : edges) origins.merge(e.property("origin"), 1, Integer::sum);

        return new MergeResult(mergedGraph, nodesAdded, nodesMerged, edgesAdded, warnings, origins);
    }

    private static String edgeKey(Edge e) {
        return e.source() + "\u0000" + e.type() + "\u0000" + e.target();
    }

    private static String defaultType(String id) {
        var colon = id.indexOf(':');
        return colon > 0 ? id.substring(0, colon) : "concept";
    }
}
