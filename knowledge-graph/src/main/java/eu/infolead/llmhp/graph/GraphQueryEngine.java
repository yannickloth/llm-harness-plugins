package eu.infolead.llmhp.graph;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public final class GraphQueryEngine {

    private GraphQueryEngine() {}

    public static Graph load(Path graphFile) throws IOException {
        if (!Files.exists(graphFile)) {
            throw new IOException("graph.json not found: " + graphFile);
        }
        var raw = Files.readString(graphFile);
        return parseJson(raw);
    }

    public static void save(Graph graph, Path outputFile) throws IOException {
        Files.writeString(outputFile, toJsonString(graph));
    }

    public static String toJsonString(Graph graph) {
        var sb = new StringBuilder(128 * 1024);
        sb.append("{\n");
        sb.append("  \"project\": \"").append(esc(graph.project())).append("\",\n");

        sb.append("  \"nodes\": [\n");
        var nodeIter = graph.nodes().values().iterator();
        while (nodeIter.hasNext()) {
            var n = nodeIter.next();
            sb.append("    {")
              .append("\"id\":\"").append(esc(n.id())).append("\",")
              .append("\"type\":\"").append(esc(n.type())).append("\",")
              .append("\"name\":\"").append(esc(n.name())).append("\",")
              .append("\"file\":\"").append(esc(n.file())).append("\",")
              .append("\"line\":\"").append(esc(n.line())).append("\",")
              .append("\"properties\":{");
            var propIter = n.properties().entrySet().iterator();
            while (propIter.hasNext()) {
                var p = propIter.next();
                sb.append("\"").append(esc(p.getKey())).append("\":\"")
                  .append(esc(p.getValue())).append("\"");
                if (propIter.hasNext()) sb.append(",");
            }
            sb.append("}}");
            if (nodeIter.hasNext()) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ],\n");

        sb.append("  \"edges\": [\n");
        var edgeIter = graph.edges().iterator();
        while (edgeIter.hasNext()) {
            var e = edgeIter.next();
            sb.append("    {")
              .append("\"source\":\"").append(esc(e.source())).append("\",")
              .append("\"target\":\"").append(esc(e.target())).append("\",")
              .append("\"type\":\"").append(esc(e.type())).append("\",")
              .append("\"properties\":{");
            var propIter = e.properties().entrySet().iterator();
            while (propIter.hasNext()) {
                var p = propIter.next();
                sb.append("\"").append(esc(p.getKey())).append("\":\"")
                  .append(esc(p.getValue())).append("\"");
                if (propIter.hasNext()) sb.append(",");
            }
            sb.append("}}");
            if (edgeIter.hasNext()) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ]");

        if (!graph.communities().isEmpty()) {
            sb.append(",\n  \"communities\": {\n");
            var comIter = graph.communities().entrySet().iterator();
            while (comIter.hasNext()) {
                var c = comIter.next();
                sb.append("    \"").append(esc(c.getKey())).append("\": [");
                var memIter = c.getValue().iterator();
                while (memIter.hasNext()) {
                    sb.append("\"").append(esc(memIter.next())).append("\"");
                    if (memIter.hasNext()) sb.append(", ");
                }
                sb.append("]");
                if (comIter.hasNext()) sb.append(",");
                sb.append("\n");
            }
            sb.append("  }");

            sb.append(",\n  \"community_summaries\": {\n");
            var sumIter = graph.communitySummaries().entrySet().iterator();
            while (sumIter.hasNext()) {
                var s = sumIter.next();
                sb.append("    \"").append(esc(s.getKey())).append("\": \"")
                  .append(esc(s.getValue())).append("\"");
                if (sumIter.hasNext()) sb.append(",");
                sb.append("\n");
            }
            sb.append("  }");
        }

        sb.append("\n}\n");
        return sb.toString();
    }

    public static Graph parseJson(String json) {
        var tokens = tokenize(json);
        var parser = new JsonParser(tokens);
        var root = parser.parseObject();

        var project = root.getString("project");

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
                props
            );
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
                props
            ));
        }

        var adj = new HashMap<String, List<String>>();
        var revAdj = new HashMap<String, List<String>>();
        for (var e : edges) {
            adj.computeIfAbsent(e.source(), k -> new ArrayList<>()).add(e.target());
            revAdj.computeIfAbsent(e.target(), k -> new ArrayList<>()).add(e.source());
        }

        var communities = new LinkedHashMap<String, List<String>>();
        var communitySummaries = new LinkedHashMap<String, String>();

        if (root.hasKey("communities")) {
            var comObj = root.getObject("communities");
            for (var k : comObj.keys()) {
                var list = new ArrayList<String>();
                for (var v : comObj.getArray(k)) list.add(v.asValue());
                communities.put(k, list);
            }
        }
        if (root.hasKey("community_summaries")) {
            var sumObj = root.getObject("community_summaries");
            for (var k : sumObj.keys()) {
                communitySummaries.put(k, sumObj.getString(k));
            }
        }

        return new Graph(project, nodes, edges, adj, revAdj, communities, communitySummaries, Map.of());
    }

    private static String esc(String s) {
        var sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.toString();
    }

    static List<Token> tokenize(String json) {
        var tokens = new ArrayList<Token>();
        int i = 0;
        while (i < json.length()) {
            var c = json.charAt(i);
            switch (c) {
                case ' ', '\t', '\n', '\r' -> i++;
                case '{' -> { tokens.add(new Token(TokenType.LBRACE, "{")); i++; }
                case '}' -> { tokens.add(new Token(TokenType.RBRACE, "}")); i++; }
                case '[' -> { tokens.add(new Token(TokenType.LBRACKET, "[")); i++; }
                case ']' -> { tokens.add(new Token(TokenType.RBRACKET, "]")); i++; }
                case ':' -> { tokens.add(new Token(TokenType.COLON, ":")); i++; }
                case ',' -> { tokens.add(new Token(TokenType.COMMA, ",")); i++; }
                case '"' -> {
                    var sb = new StringBuilder();
                    i++;
                    while (i < json.length()) {
                        var cc = json.charAt(i);
                        if (cc == '"') break;
                        if (cc == '\\') {
                            i++;
                            if (i < json.length()) {
                                var ec = json.charAt(i);
                                switch (ec) {
                                    case '"', '\\', '/' -> sb.append(ec);
                                    case 'n' -> sb.append('\n');
                                    case 'r' -> sb.append('\r');
                                    case 't' -> sb.append('\t');
                                    case 'b' -> sb.append('\b');
                                    case 'f' -> sb.append('\f');
                                    case 'u' -> {
                                        var hex = json.substring(i + 1, i + 5);
                                        sb.append((char) Integer.parseInt(hex, 16));
                                        i += 4;
                                    }
                                    default -> sb.append(ec);
                                }
                            }
                        } else {
                            sb.append(cc);
                        }
                        i++;
                    }
                    tokens.add(new Token(TokenType.STRING, sb.toString()));
                    i++;
                }
                default -> {
                    var sb = new StringBuilder();
                    while (i < json.length()) {
                        var cc = json.charAt(i);
                        if (cc == ',' || cc == '}' || cc == ']' || cc == ':' || Character.isWhitespace(cc)) break;
                        sb.append(cc);
                        i++;
                    }
                    tokens.add(new Token(TokenType.VALUE, sb.toString()));
                }
            }
        }
        return tokens;
    }

    enum TokenType { LBRACE, RBRACE, LBRACKET, RBRACKET, COLON, COMMA, STRING, VALUE }
    record Token(TokenType type, String value) {}

    static class JsonParser {
        private final List<Token> tokens;
        private int pos;

        JsonParser(List<Token> tokens) { this.tokens = tokens; this.pos = 0; }

        Token peek() { return pos < tokens.size() ? tokens.get(pos) : null; }
        Token next() { return tokens.get(pos++); }

        JsonValue parseObject() {
            expect(TokenType.LBRACE);
            var values = new LinkedHashMap<String, JsonValue>();
            while (peek() != null && peek().type() != TokenType.RBRACE) {
                var key = parseKey();
                expect(TokenType.COLON);
                values.put(key, parseValue());
                if (peek() != null && peek().type() == TokenType.COMMA) next();
            }
            expect(TokenType.RBRACE);
            return new JsonValue(JsonType.OBJECT, values);
        }

        JsonValue parseArray() {
            expect(TokenType.LBRACKET);
            var items = new ArrayList<JsonValue>();
            while (peek() != null && peek().type() != TokenType.RBRACKET) {
                items.add(parseValue());
                if (peek() != null && peek().type() == TokenType.COMMA) next();
            }
            expect(TokenType.RBRACKET);
            return new JsonValue(JsonType.ARRAY, items);
        }

        JsonValue parseValue() {
            var t = peek();
            if (t == null) throw new RuntimeException("Unexpected end of JSON");
            return switch (t.type()) {
                case LBRACE -> parseObject();
                case LBRACKET -> parseArray();
                case STRING -> { next(); yield new JsonValue(JsonType.STRING, t.value()); }
                case VALUE -> { next(); yield new JsonValue(JsonType.VALUE, t.value()); }
                default -> throw new RuntimeException("Unexpected token: " + t.type());
            };
        }

        String parseKey() {
            var t = next();
            if (t.type() != TokenType.STRING) throw new RuntimeException("Expected string key, got " + t.type());
            return t.value();
        }

        void expect(TokenType type) {
            var t = next();
            if (t == null || t.type() != type)
                throw new RuntimeException("Expected " + type + ", got " + (t != null ? t.type() : "EOF"));
        }
    }

    enum JsonType { OBJECT, ARRAY, STRING, VALUE, NULL }

    record JsonValue(JsonType type, Object data) {
        @SuppressWarnings("unchecked")
        Map<String, JsonValue> asMap() { return (Map<String, JsonValue>) data; }
        @SuppressWarnings("unchecked")
        List<JsonValue> asList() { return (List<JsonValue>) data; }
        String asValue() { return (String) data; }

        JsonValue asObject() { return this; }
        String getString(String key) {
            var v = asMap().get(key);
            return v != null ? v.asValue() : "";
        }
        String optString(String key, String def) {
            var v = asMap().get(key);
            return v != null ? v.asValue() : def;
        }
        JsonValue getObject(String key) {
            var v = asMap().get(key);
            return v != null && v.type == JsonType.OBJECT ? v
                : new JsonValue(JsonType.OBJECT, new LinkedHashMap<String, JsonValue>());
        }
        List<JsonValue> getArray(String key) {
            var v = asMap().get(key);
            return v != null && v.type == JsonType.ARRAY ? v.asList() : List.of();
        }
        boolean hasKey(String key) { return asMap().containsKey(key); }
        java.util.Set<String> keys() { return asMap().keySet(); }
    }

    public static String queryTransitiveClosure(Graph graph, String label) {
        var closure = graph.transitiveClosure(label);
        var sb = new StringBuilder();
        sb.append("Transitive closure of: ").append(label).append("\n");
        sb.append("Nodes reachable: ").append(closure.size()).append("\n\n");
        for (var id : closure) {
            var node = graph.nodes().get(id);
            if (node == null) continue;
            sb.append("  [").append(node.type()).append("] ").append(node.id()).append(" — ").append(node.name()).append("\n");
        }
        return sb.toString();
    }

    public static String queryTopoSort(Graph graph, String scope) {
        Set<String> scopeNodes;
        if (scope == null || scope.isEmpty() || scope.equals("all")) {
            scopeNodes = graph.nodes().keySet();
        } else {
            scopeNodes = graph.transitiveClosure(scope);
        }
        var order = graph.topologicalSort(scopeNodes);
        var sb = new StringBuilder();
        sb.append("Topological sort (scope: ").append(scopeNodes.size()).append(" nodes)\n\n");
        int idx = 1;
        for (var id : order) {
            var node = graph.nodes().get(id);
            if (node == null) continue;
            sb.append(String.format("  %3d. [%s] %s — %s (%s)\n",
                idx++, node.type(), node.id(), node.name(), node.file()));
        }
        return sb.toString();
    }

    public static String queryCycles(Graph graph) {
        var cycles = graph.findCycles();
        if (cycles.isEmpty()) return "No cycles detected.";
        var sb = new StringBuilder();
        sb.append("Cycles detected: ").append(cycles.size()).append("\n\n");
        int idx = 1;
        for (var cycle : cycles) {
            sb.append(String.format("  %d. ", idx++));
            sb.append(String.join(" → ", cycle));
            sb.append(" → ").append(cycle.getFirst()).append("\n");
        }
        return sb.toString();
    }

    public static String queryCommunity(Graph graph, String label) {
        var hCom = findCommunity(graph, label);
        if (hCom == null) return "No community found for: " + label;
        var summary = graph.communitySummaries().getOrDefault(hCom, "");
        var members = graph.communities().getOrDefault(hCom, List.of());

        var sb = new StringBuilder();
        sb.append("Community: ").append(hCom).append("\n\n");
        if (!summary.isEmpty()) sb.append(summary).append("\n\n");
        sb.append("Members (").append(members.size()).append("):\n");
        for (var m : members) {
            var node = graph.nodes().get(m);
            if (node != null) sb.append("  [").append(node.type()).append("] ").append(m).append("\n");
            else sb.append("  ").append(m).append("\n");
        }
        return sb.toString();
    }

    static String findCommunity(Graph graph, String label) {
        for (var e : graph.communities().entrySet()) {
            if (e.getValue().contains(label)) return e.getKey();
        }
        return null;
    }

    public static String queryContradictionCandidates(Graph graph, String scope) {
        Set<String> scopeNodes;
        if (scope == null || scope.isEmpty() || scope.equals("all")) {
            scopeNodes = graph.nodes().keySet();
        } else {
            scopeNodes = graph.transitiveClosure(scope);
        }

        var cands = new ArrayList<String>();
        for (var e : graph.edges()) {
            if (e.type().equals("contradicts") && scopeNodes.contains(e.source()) && scopeNodes.contains(e.target())) {
                cands.add(e.source() + " ↔ " + e.target());
            }
        }

        if (cands.isEmpty()) return "No explicit contradictions in scope.";
        var sb = new StringBuilder();
        sb.append("Contradictions (").append(cands.size()).append("):\n");
        for (var c : cands) sb.append("  ").append(c).append("\n");
        return sb.toString();
    }

    public static String querySubgraph(Graph graph, String label, int depth) {
        var startLabels = resolveStartLabels(graph, label);
        if (startLabels.isEmpty()) {
            return "No nodes found for: " + label;
        }

        var labels = new LinkedHashSet<String>();
        labels.addAll(startLabels);

        for (int i = 0; i < depth; i++) {
            var newLabels = new LinkedHashSet<String>();
            for (var l : labels) {
                newLabels.addAll(graph.neighbors(l));
                newLabels.addAll(graph.reverseNeighbors(l));
            }
            labels.addAll(newLabels);
        }

        var sb = new StringBuilder();
        sb.append("Subgraph for: ").append(label).append(" (depth ").append(depth).append(")\n");
        sb.append("Start nodes: ").append(startLabels.size()).append(", total: ").append(labels.size()).append("\n\n");

        for (var id : labels) {
            var node = graph.nodes().get(id);
            if (node == null) continue;
            sb.append("  [").append(node.type()).append("] ").append(id).append(" — ").append(node.name()).append("\n");
        }
        return sb.toString();
    }

    private static Set<String> resolveStartLabels(Graph graph, String label) {
        if (graph.nodes().containsKey(label)) return Set.of(label);

        if (label.contains("/") || label.contains("\\")) {
            var found = new LinkedHashSet<String>();
            for (var n : graph.nodes().values()) {
                if (label.equals(n.file()) || label.endsWith("/" + n.file())) {
                    found.add(n.id());
                }
            }
            if (!found.isEmpty()) return found;
        }

        return Set.of();
    }

    public static String queryDiff(Graph current, Graph previous) {
        var sb = new StringBuilder();
        var addedNodes = new LinkedHashSet<>(current.nodes().keySet());
        addedNodes.removeAll(previous.nodes().keySet());
        var removedNodes = new LinkedHashSet<>(previous.nodes().keySet());
        removedNodes.removeAll(current.nodes().keySet());

        var addedEdges = new ArrayList<Edge>();
        for (var e : current.edges()) {
            if (!previous.edges().contains(e)) addedEdges.add(e);
        }
        var removedEdges = new ArrayList<Edge>();
        for (var e : previous.edges()) {
            if (!current.edges().contains(e)) removedEdges.add(e);
        }

        sb.append("# Graph Diff\n\n");
        sb.append("## Nodes\n");
        sb.append("  Added: ").append(addedNodes.size()).append("\n");
        for (var n : addedNodes) {
            var node = current.nodes().get(n);
            if (node != null) sb.append("    + [").append(node.type()).append("] ").append(n).append("\n");
        }
        sb.append("  Removed: ").append(removedNodes.size()).append("\n");
        for (var n : removedNodes) {
            var node = previous.nodes().get(n);
            if (node != null) sb.append("    - [").append(node.type()).append("] ").append(n).append("\n");
        }

        sb.append("\n## Edges\n");
        sb.append("  Added: ").append(addedEdges.size()).append("\n");
        for (var e : addedEdges) {
            sb.append("    + ").append(e.source()).append(" --").append(e.type()).append("--> ").append(e.target()).append("\n");
        }
        sb.append("  Removed: ").append(removedEdges.size()).append("\n");
        for (var e : removedEdges) {
            sb.append("    - ").append(e.source()).append(" --").append(e.type()).append("--> ").append(e.target()).append("\n");
        }

        return sb.toString();
    }

    public static String queryImpact(Graph graph, String nodeId) {
        var forward = graph.transitiveClosure(nodeId);
        var backward = graph.reverseTransitiveClosure(nodeId);
        var sb = new StringBuilder();
        sb.append("Impact analysis for: ").append(nodeId).append("\n\n");
        sb.append("Depends on (").append(backward.size() - 1).append("):\n");
        for (var id : backward) {
            if (id.equals(nodeId)) continue;
            var n = graph.nodes().get(id);
            if (n != null) sb.append("  [").append(n.type()).append("] ").append(id).append("\n");
        }
        sb.append("\nDepended on by (").append(forward.size() - 1).append("):\n");
        for (var id : forward) {
            if (id.equals(nodeId)) continue;
            var n = graph.nodes().get(id);
            if (n != null) sb.append("  [").append(n.type()).append("] ").append(id).append("\n");
        }
        return sb.toString();
    }
}
