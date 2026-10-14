package eu.infolead.llmhp.graph;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public class GraphTest {

    static int passed = 0;
    static int failed = 0;

    static void assert_equals(String label, Object expected, Object actual) {
        if (Objects.equals(expected, actual)) {
            passed++;
        } else {
            failed++;
            System.err.printf("FAIL [%s] expected=%s actual=%s%n", label, expected, actual);
        }
    }

    static void assert_true(String label, boolean condition) {
        assert_equals(label, true, condition);
    }

    static void assert_notNull(String label, Object obj) {
        assert_true(label, obj != null);
    }

    static Path writeTempFile(String name, String content) throws IOException {
        var dir = Path.of("build", "test-tmp");
        Files.createDirectories(dir);
        var path = dir.resolve(name);
        Files.createDirectories(path.getParent());
        Files.writeString(path, content);
        return path;
    }

    static void cleanup() throws IOException {
        var dir = Path.of("build", "test-tmp");
        if (Files.exists(dir)) {
            try (var walk = Files.walk(dir)) {
                walk.sorted(java.util.Comparator.reverseOrder())
                    .map(Path::toFile)
                    .forEach(File::delete);
            }
        }
    }

    // --- Tests ---

    static void test_json_roundtrip() throws IOException {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("def:hello", new Node("def:hello", "def", "hello", "test.typ", "5",
            new LinkedHashMap<>(Map.of("file", "test.typ"))));
        nodes.put("thm:main", new Node("thm:main", "thm", "main-theorem", "test.typ", "10",
            new LinkedHashMap<>()));

        var edges = new ArrayList<Edge>();
        edges.add(new Edge("thm:main", "def:hello", "depends_on",
            new LinkedHashMap<>(Map.of("file", "test.typ"))));

        var communities = Map.of("c1", List.of("def:hello", "thm:main"));
        var summaries = Map.of("c1", "A test community");

        var graph = new Graph("test-project", nodes, edges,
            Map.of(), Map.of(), communities, summaries, Map.of());

        var json = GraphQueryEngine.toJsonString(graph);
        assert_true("json contains project", json.contains("\"project\": \"test-project\""));
        assert_true("json contains def:hello", json.contains("\"id\":\"def:hello\""));
        assert_true("json contains thm:main", json.contains("\"id\":\"thm:main\""));
        assert_true("json contains communities", json.contains("\"communities\""));
        assert_true("json contains community_summaries", json.contains("\"community_summaries\""));

        var parsed = GraphQueryEngine.parseJson(json);
        assert_equals("roundtrip project", "test-project", parsed.project());
        assert_equals("roundtrip node count", 2, parsed.nodes().size());
        assert_equals("roundtrip edge count", 1, parsed.edges().size());
        assert_true("roundtrip has def:hello", parsed.nodes().containsKey("def:hello"));
        assert_equals("roundtrip community count", 1, parsed.communities().size());
        assert_equals("roundtrip summary count", 1, parsed.communitySummaries().size());

        var saved = Path.of("build", "test-tmp", "roundtrip.json");
        Files.createDirectories(saved.getParent());
        GraphQueryEngine.save(graph, saved);
        assert_true("saved file exists", Files.exists(saved));

        var reloaded = GraphQueryEngine.load(saved);
        assert_equals("reloaded project", "test-project", reloaded.project());
        assert_equals("reloaded nodes", 2, reloaded.nodes().size());
    }

    static void test_transitive_closure_null_guard() {
        var nodes = new LinkedHashMap<String, Node>();
        var graph = new Graph("test", nodes, List.of(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var result = graph.transitiveClosure(null);
        assert_equals("tc null returns empty", true, result.isEmpty());

        result = graph.transitiveClosure("nonexistent");
        assert_equals("tc nonexistent returns empty", true, result.isEmpty());
    }

    static void test_reverse_transitive_closure_null_guard() {
        var graph = new Graph("test", Map.of(), List.of(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var result = graph.reverseTransitiveClosure(null);
        assert_equals("rtc null returns empty", true, result.isEmpty());

        result = graph.reverseTransitiveClosure("nonexistent");
        assert_equals("rtc nonexistent returns empty", true, result.isEmpty());
    }

    static void test_query_transitive_closure_null() {
        var graph = new Graph("test", Map.of(), List.of(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of());
        var result = GraphQueryEngine.queryTransitiveClosure(graph, null);
        assert_true("qtc null returns error", result.startsWith("Error"));

        result = GraphQueryEngine.queryTransitiveClosure(graph, "");
        assert_true("qtc empty returns error", result.startsWith("Error"));
    }

    static void test_query_community_null() {
        var graph = new Graph("test", Map.of(), List.of(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of());
        var result = GraphQueryEngine.queryCommunity(graph, null);
        assert_true("qcomm null returns error", result.startsWith("Error"));

        result = GraphQueryEngine.queryCommunity(graph, "");
        assert_true("qcomm empty returns error", result.startsWith("Error"));
    }

    static void test_query_impact_null() {
        var graph = new Graph("test", Map.of(), List.of(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of());
        var result = GraphQueryEngine.queryImpact(graph, null);
        assert_true("qimpact null returns error", result.startsWith("Error"));

        result = GraphQueryEngine.queryImpact(graph, "");
        assert_true("qimpact empty returns error", result.startsWith("Error"));
    }

    static void test_query_subgraph_null() {
        var graph = new Graph("test", Map.of(), List.of(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of());
        var result = GraphQueryEngine.querySubgraph(graph, null, 1);
        assert_true("qsub null returns error", result.startsWith("Error"));
    }

    static void test_transitive_closure_works() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));
        nodes.put("c", new Node("c", "test", "c", "", "0", Map.of()));

        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "b", "depends_on", Map.of()));
        edges.add(new Edge("b", "c", "depends_on", Map.of()));

        var adj = Map.of("a", List.of("b"), "b", List.of("c"));
        var rev = Map.of("b", List.of("a"), "c", List.of("b"));

        var graph = new Graph("test", nodes, edges, adj, rev, Map.of(), Map.of(), Map.of());

        var closure = graph.transitiveClosure("a");
        assert_equals("tc a size", 3, closure.size());
        assert_true("tc a contains a", closure.contains("a"));
        assert_true("tc a contains b", closure.contains("b"));
        assert_true("tc a contains c", closure.contains("c"));

        var reverse = graph.reverseTransitiveClosure("c");
        assert_equals("rtc c size", 3, reverse.size());
        assert_true("rtc c contains a", reverse.contains("a"));
        assert_true("rtc c contains b", reverse.contains("b"));
        assert_true("rtc c contains c", reverse.contains("c"));
    }

    static void test_cycles_detection() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));

        var adj = Map.of("a", List.of("b"), "b", List.of("a"));
        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "b", "depends_on", Map.of()));
        edges.add(new Edge("b", "a", "depends_on", Map.of()));
        var graph = new Graph("test", nodes, edges, adj, Map.of(), Map.of(), Map.of(), Map.of());

        var cycles = graph.findCycles();
        assert_true("has cycle", !cycles.isEmpty());
    }

    static void test_no_false_cycles() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));

        var adj = Map.of("a", List.of("b"));
        var graph = new Graph("test", nodes, List.of(), adj, Map.of(), Map.of(), Map.of(), Map.of());

        var cycles = graph.findCycles();
        assert_true("no cycle", cycles.isEmpty());
    }

    static void test_topological_sort() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));
        nodes.put("c", new Node("c", "test", "c", "", "0", Map.of()));

        var adj = Map.of("a", List.of("b"), "b", List.of("c"));
        var graph = new Graph("test", nodes, List.of(), adj, Map.of(), Map.of(), Map.of(), Map.of());

        var order = graph.topologicalSort(new LinkedHashSet<>(List.of("a", "b", "c")));
        assert_equals("topo sort size", 3, order.size());
        assert_equals("topo a before b", true, order.indexOf("a") < order.indexOf("b"));
        assert_equals("topo b before c", true, order.indexOf("b") < order.indexOf("c"));
    }

    static void test_topological_sort_cycle() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));

        var adj = Map.of("a", List.of("b"), "b", List.of("a"));
        var graph = new Graph("test", nodes, List.of(), adj, Map.of(), Map.of(), Map.of(), Map.of());

        var order = graph.topologicalSort(new LinkedHashSet<>(List.of("a", "b")));
        assert_true("topo cycle warns", order.getLast().contains("cycle"));
    }

    static void test_json_parse_ivp_graph() throws IOException {
        var path = Path.of("../../ivp-book-series/graph.json");
        if (!Files.exists(path)) {
            System.out.println("SKIP: ivp-book-series/graph.json not found (run from knowledge-graph dir)");
            return;
        }
        var graph = GraphQueryEngine.load(path);
        assert_notNull("ivp graph loaded", graph);
        assert_true("ivp has nodes", graph.nodes().size() > 0);
        assert_true("ivp has edges", graph.edges().size() > 0);
    }

    static void test_json_escaped_strings() {
        var props = new LinkedHashMap<String, String>();
        props.put("desc", "a \"quoted\" field");
        var node = new Node("x", "def", "name", "file.typ", "1", props);
        var graph = new Graph("test", Map.of("x", node), List.of(),
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var json = GraphQueryEngine.toJsonString(graph);
        assert_true("escaped quote in json", json.contains("a \\\"quoted\\\" field"));
    }

    static void test_json_special_chars() {
        var props = new LinkedHashMap<String, String>();
        props.put("desc", "new\nline\ttab");
        var node = new Node("x", "def", "name", "file.typ", "1", props);
        var graph = new Graph("test", Map.of("x", node), List.of(),
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var json = GraphQueryEngine.toJsonString(graph);
        var parsed = GraphQueryEngine.parseJson(json);
        assert_equals("roundtrip special chars", "new\nline\ttab",
            parsed.nodes().get("x").properties().get("desc"));
    }

    static void test_query_impact_works() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));

        var adj = Map.of("a", List.of("b"));
        var rev = Map.of("b", List.of("a"));
        var graph = new Graph("test", nodes, List.of(),
            adj, rev, Map.of(), Map.of(), Map.of());

        var result = GraphQueryEngine.queryImpact(graph, "a");
        assert_true("impact has depends on", result.contains("Depends on"));
        assert_true("impact has depended on by", result.contains("Depended on by"));
        assert_true("impact contains b", result.contains("b"));
    }

    static void test_empty_graph_cycles() {
        var graph = new Graph("test", Map.of(), List.of(),
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var result = GraphQueryEngine.queryCycles(graph);
        assert_true("empty graph no cycles", result.contains("No cycles"));
    }

    static void test_json_without_communities() {
        var graph = new Graph("test", Map.of(), List.of(),
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var json = GraphQueryEngine.toJsonString(graph);
        assert_true("no communities in json", !json.contains("\"communities\""));
        assert_true("no community_summaries in json", !json.contains("\"community_summaries\""));

        var parsed = GraphQueryEngine.parseJson(json);
        assert_equals("parsed no communities", 0, parsed.communities().size());
        assert_equals("parsed no summaries", 0, parsed.communitySummaries().size());
    }

    static void test_query_subgraph_filepath() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("def:x", new Node("def:x", "def", "x", "foo/test.typ", "5", Map.of()));
        nodes.put("def:y", new Node("def:y", "def", "y", "foo/test.typ", "10", Map.of()));

        var adj = Map.of("def:x", List.of("def:y"));
        var graph = new Graph("test", nodes, List.of(),
            adj, Map.of(), Map.of(), Map.of(), Map.of());

        var result = GraphQueryEngine.querySubgraph(graph, "foo/test.typ", 1);
        assert_true("subgraph filepath finds nodes", result.contains("def:x"));
        assert_true("subgraph filepath finds def:y", result.contains("def:y"));
    }

    static void test_query_contradictions_no_scope() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));

        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "b", "contradicts", Map.of()));

        var graph = new Graph("test", nodes, edges,
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var result = GraphQueryEngine.queryContradictionCandidates(graph, null);
        assert_true("contradictions with null scope", result.contains("a") && result.contains("b"));
    }

    static void test_impact_null_label() {
        var graph = new Graph("test", Map.of(), List.of(),
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var result = GraphQueryEngine.queryImpact(graph, null);
        assert_true("impact null returns error", result.startsWith("Error"));
    }

    static void test_subgraph_nonexistent_label() {
        var graph = new Graph("test", Map.of(), List.of(),
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var result = GraphQueryEngine.querySubgraph(graph, "nonexistent", 1);
        assert_true("subgraph nonexistent says no nodes", result.contains("No nodes found"));
    }

    static void test_transitive_closure_depth_limit() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));
        nodes.put("c", new Node("c", "test", "c", "", "0", Map.of()));
        nodes.put("d", new Node("d", "test", "d", "", "0", Map.of()));

        var adj = Map.of("a", List.of("b"), "b", List.of("c"), "c", List.of("d"));
        var graph = new Graph("test", nodes, List.of(), adj, Map.of(), Map.of(), Map.of(), Map.of());

        var tc1 = graph.transitiveClosure("a", 1);
        assert_equals("tc depth=1 size", 2, tc1.size());
        assert_true("tc depth=1 has a", tc1.contains("a"));
        assert_true("tc depth=1 has b", tc1.contains("b"));
        assert_true("tc depth=1 not c", !tc1.contains("c"));

        var tc2 = graph.transitiveClosure("a", 2);
        assert_equals("tc depth=2 size", 3, tc2.size());
        assert_true("tc depth=2 has c", tc2.contains("c"));
        assert_true("tc depth=2 not d", !tc2.contains("d"));

        var tcFull = graph.transitiveClosure("a");
        assert_equals("tc default depth size", 4, tcFull.size());
    }

    static void test_quality_metrics() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "thm", "A", "f1.typ", "1", Map.of()));
        nodes.put("b", new Node("b", "def", "B", "f1.typ", "5", Map.of()));
        nodes.put("c", new Node("c", "def", "C", "f2.typ", "3", Map.of()));
        nodes.put("file:f1", new Node("file:f1", "file", "f1.typ", "f1.typ", "0", Map.of()));
        nodes.put("file:f2", new Node("file:f2", "file", "f2.typ", "f2.typ", "0", Map.of()));

        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "b", "depends_on", Map.of()));
        edges.add(new Edge("a", "c", "depends_on", Map.of()));

        var communities = new LinkedHashMap<String, List<String>>();
        communities.put("c1", List.of("a", "b", "c"));

        var summaries = new LinkedHashMap<String, String>();
        summaries.put("c1", "Test community");

        var graph = new Graph("test", nodes, edges, Map.of(), Map.of(),
            communities, summaries, Map.of());

        var result = GraphQueryEngine.computeQualityMetrics(graph);
        assert_true("quality has entity coverage", result.contains("Entity coverage"));
        assert_true("quality has density", result.contains("Relationship density"));
        assert_true("quality has modularity", result.contains("Community coherence"));
        assert_true("quality has summary quality", result.contains("Summary quality"));
    }

    static void test_validate_schema() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "thm", "A", "", "0", Map.of()));
        nodes.put("b", new Node("b", "def", "B", "", "0", Map.of()));

        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "b", "depends_on", Map.of()));

        var graph = new Graph("test", nodes, edges, Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var issues = GraphQueryEngine.validateSchema(graph);
        assert_equals("validate clean graph has no issues", 0, issues.size());
    }

    static void test_validate_dangling_refs() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "thm", "A", "", "0", Map.of()));

        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "nonexistent", "depends_on", Map.of()));
        edges.add(new Edge("ghost", "a", "depends_on", Map.of()));

        var graph = new Graph("test", nodes, edges, Map.of(), Map.of(), Map.of(), Map.of(), Map.of());

        var issues = GraphQueryEngine.validateSchema(graph);
        assert_true("validate finds dangling refs", issues.size() > 0);
    }

    static void test_leiden_resolution_param() {
        var nodes = new LinkedHashMap<String, Node>();
        for (int i = 0; i < 30; i++) {
            var id = "n" + i;
            nodes.put(id, new Node(id, "def", "N" + i, "", "0", Map.of()));
        }
        var edges = new ArrayList<Edge>();
        var adj = new LinkedHashMap<String, java.util.List<String>>();
        for (int i = 0; i < 29; i++) {
            var src = "n" + i;
            var tgt = "n" + (i + 1);
            adj.computeIfAbsent(src, k -> new ArrayList<>()).add(tgt);
            adj.computeIfAbsent(tgt, k -> new ArrayList<>()).add(src);
            edges.add(new Edge(src, tgt, "depends_on", Map.of()));
        }
        var graph = new Graph("test", nodes, edges, adj, Map.of(), Map.of(), Map.of(), Map.of());

        var lowRes = CommunityDetector.detect(graph, 42L, 0.5);
        var highRes = CommunityDetector.detect(graph, 42L, 2.0);

        assert_true("lowRes produces communities", lowRes.communities().size() > 0);
        assert_true("highRes produces communities", highRes.communities().size() > 0);
        assert_true("highRes has more communities than lowRes",
            highRes.communities().size() >= lowRes.communities().size());
    }

    static void test_entity_resolution_merges_duplicates() throws IOException {
        writeTempFile("er-test/main.typ", "<ch:foo>\n<ch:foo>\n");
        writeTempFile("er-test/other.typ", "<ch:foo>\n");

        var configContent = """
            project:
              name: er-test
            label_rules:
              - regex: '<([a-zA-Z][a-zA-Z0-9_:-]+)>'
                type: def
            edge_rules: []
            naming_conventions: {}
            structural_prefixes: []
            """;
        var configFile = writeTempFile("er-config.yaml", configContent);

        var projectRoot = Path.of("build", "test-tmp", "er-test");
        var config = GraphPreprocessor.loadConfig(configFile);
        var processor = new GraphPreprocessor(config, projectRoot);
        var graph = processor.process();

        assert_equals("entity resolution kept node for ch:foo", true,
            graph.nodes().containsKey("ch:foo"));
        var chFoo = graph.nodes().get("ch:foo");
        var files = chFoo.property("files");
        assert_true("entity resolution recorded multiple files",
            files.contains("main.typ") && files.contains("other.typ"));
    }

    static void test_entity_resolution_no_self_loops() throws IOException {
        writeTempFile("er-self/main.typ", "<thm:main> depends on <def:shared>.\n");
        writeTempFile("er-self/other.typ", "<def:shared> is referenced.\n");

        var configContent = """
            project:
              name: er-self-test
            label_rules:
              - regex: '<([a-zA-Z][a-zA-Z0-9_:-]+)>'
                type: def
            edge_rules: []
            naming_conventions: {}
            structural_prefixes: []
            """;
        var configFile = writeTempFile("er-self-config.yaml", configContent);

        var projectRoot = Path.of("build", "test-tmp", "er-self");
        var config = GraphPreprocessor.loadConfig(configFile);
        var processor = new GraphPreprocessor(config, projectRoot);
        var graph = processor.process();

        var selfLoops = graph.edges().stream()
            .filter(e -> e.source().equals(e.target())).count();
        assert_equals("no self-loop edges after resolution", 0L, selfLoops);
    }

    static void test_quality_metrics_empty_graph() {
        var graph = new Graph("test", Map.of(), List.of(),
            Map.of(), Map.of(), Map.of(), Map.of(), Map.of());
        var result = GraphQueryEngine.computeQualityMetrics(graph);
        assert_true("empty graph quality reports entity coverage", result.contains("Entity coverage"));
        assert_true("empty graph quality reports density", result.contains("Relationship density"));
        assert_true("empty graph no NaN/Infinity",
            !result.contains("NaN") && !result.contains("Infinity") && !result.contains("Exception"));
    }

    static void test_quality_metrics_no_communities() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "thm", "A", "f.typ", "1", Map.of()));
        nodes.put("f", new Node("f", "file", "f.typ", "f.typ", "0", Map.of()));
        var graph = new Graph("test", nodes, List.of(), Map.of(), Map.of(),
            Map.of(), Map.of(), Map.of());
        var result = GraphQueryEngine.computeQualityMetrics(graph);
        assert_true("no-community quality reports entity coverage", result.contains("Entity coverage"));
        assert_true("no-community quality no NaN/Infinity",
            !result.contains("NaN") && !result.contains("Infinity") && !result.contains("Exception"));
    }

    // --- Runner ---

    public static void main(String[] args) throws IOException {
        test_json_roundtrip();
        test_transitive_closure_null_guard();
        test_reverse_transitive_closure_null_guard();
        test_query_transitive_closure_null();
        test_query_community_null();
        test_query_impact_null();
        test_query_subgraph_null();
        test_transitive_closure_works();
        test_cycles_detection();
        test_no_false_cycles();
        test_topological_sort();
        test_topological_sort_cycle();
        test_json_parse_ivp_graph();
        test_json_escaped_strings();
        test_json_special_chars();
        test_query_impact_works();
        test_empty_graph_cycles();
        test_json_without_communities();
        test_query_subgraph_filepath();
        test_query_contradictions_no_scope();
        test_impact_null_label();
        test_subgraph_nonexistent_label();
        test_transitive_closure_depth_limit();
        test_quality_metrics();
        test_validate_schema();
        test_validate_dangling_refs();
        test_leiden_resolution_param();
        test_entity_resolution_merges_duplicates();
        test_entity_resolution_no_self_loops();
        test_quality_metrics_empty_graph();
        test_quality_metrics_no_communities();
        test_diagram_export();
        test_diagram_null_and_missing();
        test_diagram_file_label();
        test_perspectives_tree();
        test_merge_annotations();
        test_merge_annotations_no_change();
        test_merge_annotations_stale_label();
        test_audit_tree();
        test_overlay_parse_and_merge();
        test_overlay_property_precedence();
        test_overlay_edge_dedup();
        test_overlay_auto_create_endpoint();
        test_overlay_validate();
        test_overlay_preserves_origin();
        test_overlay_skips_malformed();
        test_perspectives_preserves_edits();
        test_perspectives_reclaims_mismatched_dir();
        test_perspectives_dir_collision();
        test_diagram_truncation_keeps_focus();
        test_community_mermaid_edges();
        test_cli_usage_guards();

        System.out.printf("Results: %d passed, %d failed%n", passed, failed);
        if (failed > 0) {
            System.err.println("SOME TESTS FAILED");
            System.exit(1);
        }

        cleanup();
    }

    // --- Perspective doc-tree tests ---

    static Graph smallGraph() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "test", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "test", "b", "", "0", Map.of()));
        nodes.put("c", new Node("c", "test", "c", "", "0", Map.of()));
        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "b", "depends_on", Map.of()));
        edges.add(new Edge("b", "c", "depends_on", Map.of()));
        var adj = Map.of("a", List.of("b"), "b", List.of("c"));
        var rev = Map.of("b", List.of("a"), "c", List.of("b"));
        return new Graph("test", nodes, edges, adj, rev, Map.of(), Map.of(), Map.of());
    }

    static void test_diagram_export() {
        var graph = smallGraph();
        var diagram = PerspectiveExporter.exportDiagram(graph, "a", 1);
        assert_true("diagram flowchart header", diagram.contains("flowchart LR"));
        assert_true("diagram node a", diagram.contains("\"a\""));
        assert_true("diagram edge label", diagram.contains("-->|depends_on|"));
        assert_true("diagram excludes c at depth 1", !diagram.contains("\"c\""));
        var deep = PerspectiveExporter.exportDiagram(graph, "a", 2);
        assert_true("diagram depth 2 includes c", deep.contains("\"c\""));
    }

    static void test_diagram_null_and_missing() {
        assert_true("diagram null error", PerspectiveExporter.exportDiagram(smallGraph(), null, 1).startsWith("Error"));
        assert_true("diagram empty error", PerspectiveExporter.exportDiagram(smallGraph(), "", 1).startsWith("Error"));
        assert_true("diagram missing", PerspectiveExporter.exportDiagram(smallGraph(), "zzz", 1).startsWith("No nodes"));
    }

    static void test_diagram_file_label() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "def", "a", "src/x.typ", "3", Map.of()));
        var graph = new Graph("test", nodes, new ArrayList<>(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of());
        var diagram = PerspectiveExporter.exportDiagram(graph, "src/x.typ", 1);
        assert_true("diagram resolves file label", diagram.contains("\"a\""));
    }

    static void test_perspectives_tree() throws IOException {
        var graph = smallGraph();
        var outDir = Path.of("build", "test-tmp", "persp");
        var summary = PerspectiveExporter.exportPerspectives(graph, outDir, 10);
        assert_true("perspectives summary mentions elements", summary.contains("element dirs"));
        assert_true("overall description exists", Files.exists(outDir.resolve("overall-architecture/description.md")));
        assert_true("overall diagram exists", Files.exists(outDir.resolve("overall-architecture/diagram.mmd")));
        assert_true("overall diagram flowchart", Files.readString(outDir.resolve("overall-architecture/diagram.mmd")).contains("flowchart LR"));
        var elementDir = outDir.resolve("elements/a");
        assert_true("element dir exists", Files.isDirectory(elementDir));
        var desc = Files.readString(elementDir.resolve("description.md"));
        assert_true("element frontmatter label", desc.contains("label: a"));
        assert_true("element frontmatter constraint", desc.contains("constraint:"));
        assert_true("element diagram exists", Files.exists(elementDir.resolve("diagram.mmd")));
        assert_true("element context exists", Files.exists(elementDir.resolve("context.md")));
    }

    static void test_merge_annotations() throws IOException {
        var graph = smallGraph();
        var treeDir = Path.of("build", "test-tmp", "merge-tree");
        var el = treeDir.resolve("elements/a");
        Files.createDirectories(el);
        Files.writeString(el.resolve("description.md"), """
            ---
            label: a
            type: test
            constraint: single owner
            todo: verify claim
            contradicts: c, missing
            ---

            body
            """);
        var result = PerspectiveExporter.mergeAnnotations(graph, treeDir);
        assert_equals("merge property updates", 2, result.properties());
        assert_equals("merge edges added", 1, result.edges());
        assert_equals("merge warnings", 1, result.warnings().size());
        assert_true("merge dangling warning", result.warnings().getFirst().contains("dangling contradicts"));
        var merged = result.graph().nodes().get("a");
        assert_equals("merged constraint property", "single owner", merged.property("constraint"));
        assert_equals("merged todo property", "verify claim", merged.property("todo"));
        var edge = result.graph().edges().stream()
            .filter(e -> e.type().equals("contradicts")).findFirst().orElseThrow();
        assert_equals("merge edge source", "a", edge.source());
        assert_equals("merge edge target", "c", edge.target());
        assert_equals("merge edge origin", "archi-scan", edge.property("origin"));
    }

    static void test_merge_annotations_no_change() throws IOException {
        var graph = smallGraph();
        var treeDir = Path.of("build", "test-tmp", "merge-empty");
        var el = treeDir.resolve("elements/a");
        Files.createDirectories(el);
        Files.writeString(el.resolve("description.md"), "---\nlabel: a\nconstraint: \n---\n\nbody\n");
        var result = PerspectiveExporter.mergeAnnotations(graph, treeDir);
        assert_equals("no-change properties", 0, result.properties());
        assert_true("no-change returns same graph", result.graph() == graph);
    }

    static void test_merge_annotations_stale_label() throws IOException {
        var graph = smallGraph();
        var treeDir = Path.of("build", "test-tmp", "merge-stale");
        var el = treeDir.resolve("elements/ghost");
        Files.createDirectories(el);
        Files.writeString(el.resolve("description.md"), "---\nlabel: ghost\nconstraint: x\n---\n");
        var result = PerspectiveExporter.mergeAnnotations(graph, treeDir);
        assert_true("stale warning", result.warnings().stream().anyMatch(w -> w.contains("stale label")));
    }

    static void test_audit_tree() throws IOException {
        var graph = smallGraph();
        var treeDir = Path.of("build", "test-tmp", "audit-tree");
        var el = treeDir.resolve("elements/b");
        Files.createDirectories(el);
        Files.writeString(el.resolve("description.md"),
            "---\nlabel: b\nfiles: gone.typ:4\ncontradicts: zzz\n---\n");
        var issues = PerspectiveExporter.auditTree(graph, treeDir, Path.of("build", "test-tmp"));
        assert_true("audit missing file anchor", issues.stream().anyMatch(i -> i.contains("missing file anchor")));
        assert_true("audit dangling edge target", issues.stream().anyMatch(i -> i.contains("dangling contradicts")));

        Files.createDirectories(Path.of("build", "test-tmp"));
        Files.writeString(Path.of("build", "test-tmp", "gone.typ"), "x");
        var issues2 = PerspectiveExporter.auditTree(graph, treeDir, Path.of("build", "test-tmp"));
        assert_true("audit clean when anchor exists", issues2.stream().noneMatch(i -> i.contains("missing file anchor")));
    }

    // --- Overlay tests ---

    static void test_overlay_parse_and_merge() {
        var base = smallGraph();
        var overlay = GraphOverlay.parse("""
            {
              "origin": "llm:test-model",
              "nodes": [
                {"id":"concept:d","type":"concept","name":"D","properties":{}}
              ],
              "edges": [
                {"source":"a","target":"concept:d","type":"generalizes","properties":{"note":"x"}}
              ]
            }
            """);
        assert_equals("overlay origin", "llm:test-model", overlay.origin());
        assert_equals("overlay nodes", 1, overlay.nodes().size());
        var result = GraphOverlay.merge(base, overlay, null);
        assert_equals("overlay nodes added", 1, result.nodesAdded());
        assert_equals("overlay edges added", 1, result.edgesAdded());
        var d = result.graph().nodes().get("concept:d");
        assert_equals("overlay node origin", "llm:test-model", d.property("origin"));
        assert_equals("overlay node type", "concept", d.type());
        assert_equals("overlay edge origin", "llm:test-model",
            result.graph().edges().stream().filter(e -> e.type().equals("generalizes"))
                .findFirst().orElseThrow().property("origin"));
        assert_equals("overlay origin count", Integer.valueOf(2), result.origins().get("llm:test-model"));
    }

    static void test_overlay_property_precedence() {
        var base = smallGraph();
        var overlay = GraphOverlay.parse("""
            {"nodes":[{"id":"b","type":"","name":"","file":"overlay.typ","line":"42","properties":{"constraint":"keep"}}]}
            """);
        var result = GraphOverlay.merge(base, overlay, "llm:test");
        assert_equals("precedence nodes merged", 1, result.nodesMerged());
        var b = result.graph().nodes().get("b");
        assert_equals("precedence constraint", "keep", b.property("constraint"));
        assert_equals("precedence file override", "overlay.typ", b.file());
        assert_equals("precedence line override", "42", b.line());
        assert_equals("precedence type kept", "test", b.type());
        assert_equals("precedence origin", "llm:test", b.property("origin"));
    }

    static void test_overlay_edge_dedup() {
        var base = smallGraph();
        var overlay = GraphOverlay.parse("""
            {"nodes":[],"edges":[{"source":"a","target":"b","type":"depends_on","properties":{"note":"dup"}}]}
            """);
        var result = GraphOverlay.merge(base, overlay, "llm:test");
        assert_equals("dedup edges added", 0, result.edgesAdded());
        assert_equals("dedup edge count", 2, result.graph().edges().size());
        var e = result.graph().edges().stream()
            .filter(x -> x.type().equals("depends_on") && x.source().equals("a")).findFirst().orElseThrow();
        assert_equals("dedup merged prop", "dup", e.property("note"));
    }

    static void test_overlay_auto_create_endpoint() {
        var base = smallGraph();
        var overlay = GraphOverlay.parse("""
            {"nodes":[],"edges":[{"source":"a","target":"concept:ghost","type":"relates","properties":{}}]}
            """);
        var result = GraphOverlay.merge(base, overlay, "llm:test");
        assert_true("auto-create node", result.graph().nodes().containsKey("concept:ghost"));
        assert_equals("auto-create type", "concept", result.graph().nodes().get("concept:ghost").type());
        assert_equals("auto-create flagged", "true",
            result.graph().nodes().get("concept:ghost").property("auto-created"));
        assert_true("auto-create warning",
            result.warnings().stream().anyMatch(w -> w.contains("auto-created")));
    }

    static void test_overlay_validate() {
        var overlay = GraphOverlay.parse("""
            {
              "nodes":[
                {"id":"","type":"concept","properties":{}},
                {"id":"x","type":"","properties":{}}
              ],
              "edges":[
                {"source":"x","target":"x","type":"loop","properties":{}},
                {"source":"","target":"y","type":"z","properties":{}}
              ]
            }
            """);
        var issues = GraphOverlay.validate(overlay);
        assert_true("validate empty id", issues.stream().anyMatch(i -> i.contains("Empty node ID")));
        assert_true("validate empty type", issues.stream().anyMatch(i -> i.contains("Empty type for node: x")));
        assert_true("validate self-loop", issues.stream().anyMatch(i -> i.contains("Self-loop edge: x")));
        assert_true("validate blank endpoint", issues.stream().anyMatch(i -> i.contains("blank endpoint")));
    }

    static void test_overlay_preserves_origin() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "thm", "A", "", "0",
            new LinkedHashMap<>(Map.of("origin", "deterministic"))));
        var graph = new Graph("t", nodes, new ArrayList<>(), Map.of(), Map.of(),
            Map.of(), Map.of(), Map.of());
        var overlay = GraphOverlay.parse(
            "{\"nodes\":[{\"id\":\"a\",\"type\":\"\",\"properties\":{\"note\":\"n\"}}]}");
        var result = GraphOverlay.merge(graph, overlay, "llm:test");
        assert_equals("origin preserved", "deterministic",
            result.graph().nodes().get("a").property("origin"));
        assert_equals("note added", "n", result.graph().nodes().get("a").property("note"));
    }

    static void test_overlay_skips_malformed() {
        var base = smallGraph();
        var overlay = GraphOverlay.parse("""
            {"nodes":[{"id":"","type":"concept","properties":{}}],
             "edges":[{"source":"","target":"a","type":"x","properties":{}}]}
            """);
        var result = GraphOverlay.merge(base, overlay, "llm:test");
        assert_equals("skips blank node", 3, result.graph().nodes().size());
        assert_equals("skips blank edge", 2, result.graph().edges().size());
        assert_true("skip warnings", result.warnings().stream().anyMatch(w -> w.contains("blank")));
    }

    static void test_perspectives_preserves_edits() throws IOException {
        var graph = smallGraph();
        var outDir = Path.of("build", "test-tmp", "persp-preserve");
        PerspectiveExporter.exportPerspectives(graph, outDir, 10);
        var desc = outDir.resolve("elements/a/description.md");
        Files.writeString(desc, "---\nlabel: a\nconstraint: handcrafted\n---\n\nedited body\n");
        var summary = PerspectiveExporter.exportPerspectives(graph, outDir, 10);
        assert_true("preserved reported", summary.contains("preserved"));
        assert_true("edit preserved", Files.readString(desc).contains("handcrafted"));
        assert_true("diagram refreshed", Files.exists(outDir.resolve("elements/a/diagram.mmd")));
    }

    static void test_perspectives_reclaims_mismatched_dir() throws IOException {
        var graph = smallGraph();
        var outDir = Path.of("build", "test-tmp", "persp-mismatch");
        var dir = outDir.resolve("elements/a");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("description.md"),
            "---\nlabel: someone-else\nconstraint: old\n---\n");
        PerspectiveExporter.exportPerspectives(graph, outDir, 10);
        assert_true("mismatched dir reclaimed",
            Files.readString(dir.resolve("description.md")).contains("label: a"));
    }

    static void test_perspectives_dir_collision() throws IOException {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a:b", new Node("a:b", "t", "x", "", "0", Map.of()));
        nodes.put("a_b", new Node("a_b", "t", "y", "", "0", Map.of()));
        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a:b", "a_b", "depends_on", Map.of()));
        var graph = new Graph("t", nodes, edges, Map.of("a:b", List.of("a_b")),
            Map.of("a_b", List.of("a:b")), Map.of(), Map.of(), Map.of());
        var outDir = Path.of("build", "test-tmp", "persp-collide");
        PerspectiveExporter.exportPerspectives(graph, outDir, 10);
        List<String> dirs;
        try (var s = Files.list(outDir.resolve("elements"))) {
            dirs = s.map(p -> p.getFileName().toString()).sorted().toList();
        }
        assert_equals("collision dirs count", 2, dirs.size());
        assert_true("collision disambiguated", dirs.contains("a_b") && dirs.contains("a_b-2"));
    }

    static void test_diagram_truncation_keeps_focus() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("z:center", new Node("z:center", "center", "Center", "", "0", Map.of()));
        var neigh = new ArrayList<String>();
        var edges = new ArrayList<Edge>();
        for (int i = 0; i < 44; i++) {
            var id = "n:" + String.format("%02d", i);
            nodes.put(id, new Node(id, "n", id, "", "0", Map.of()));
            edges.add(new Edge("z:center", id, "depends_on", Map.of()));
            neigh.add(id);
        }
        var rev = new LinkedHashMap<String, List<String>>();
        for (var id : neigh) rev.put(id, List.of("z:center"));
        var graph = new Graph("t", nodes, edges, Map.of("z:center", neigh), rev,
            Map.of(), Map.of(), Map.of());
        var diagram = PerspectiveExporter.exportDiagram(graph, "z:center", 1);
        assert_true("focus retained under truncation", diagram.contains("\"z:center\""));
        assert_true("truncation comment", diagram.contains("focus node retained"));
        assert_true("far node dropped", !diagram.contains("\"n:43\""));
    }

    static void test_community_mermaid_edges() {
        var nodes = new LinkedHashMap<String, Node>();
        nodes.put("a", new Node("a", "t", "a", "", "0", Map.of()));
        nodes.put("b", new Node("b", "t", "b", "", "0", Map.of()));
        var edges = new ArrayList<Edge>();
        edges.add(new Edge("a", "b", "depends_on", Map.of()));
        var communities = new LinkedHashMap<String, List<String>>();
        communities.put("community-0", List.of("a"));
        communities.put("community-1", List.of("b"));
        var graph = new Graph("t", nodes, edges, Map.of("a", List.of("b")),
            Map.of("b", List.of("a")), communities, Map.of(), Map.of());
        var mermaid = PerspectiveExporter.communityMermaid(graph);
        assert_true("community nodes present",
            mermaid.contains("community-0 (1)") && mermaid.contains("community-1 (1)"));
        assert_true("community cross edge", mermaid.contains("-->|1|"));
    }

    static void test_cli_usage_guards() throws IOException {
        var out = System.out;
        var err = System.err;
        var sink = new java.io.PrintStream(java.io.OutputStream.nullOutputStream());
        System.setOut(sink);
        System.setErr(sink);
        try {
            GraphCli.dispatch(new String[]{"impact", "graph.json"});
            GraphCli.dispatch(new String[]{"context", "graph.json"});
            GraphCli.dispatch(new String[]{"subgraph", "graph.json"});
            GraphCli.dispatch(new String[]{"query", "graph.json"});
            GraphCli.dispatch(new String[]{"rate", "graph.json"});
            GraphCli.dispatch(new String[]{"overview"});
            GraphCli.dispatch(new String[]{"quality"});
            GraphCli.dispatch(new String[]{"validate"});
            GraphCli.dispatch(new String[]{"diagram", "graph.json"});
            GraphCli.dispatch(new String[]{"validate-overlay"});
            assert_true("usage guards: no exception", true);
        } catch (RuntimeException e) {
            assert_true("usage guards: unexpected " + e, false);
        } finally {
            System.setOut(out);
            System.setErr(err);
        }
    }
}
