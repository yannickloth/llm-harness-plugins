package eu.infolead.llmhp.graph;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.graph.types.*;

public class GraphCli {

    private GraphCli() {}

    public static void main(String[] args) {
        try {
            dispatch(args);
        } catch (IOException e) {
            System.err.println("ERROR: " + e.getMessage());
            System.exit(1);
        }
    }

    static void dispatch(String[] args) throws IOException {
        if (args.length < 1) { usage(); return; }
        var cmd = args[0];

        switch (cmd) {
            case "parse" -> handleParse(args);
            case "query" -> handleQuery(args);
            case "context" -> handleContext(args);
            case "impact" -> handleImpact(args);
            case "subgraph" -> handleSubgraph(args);
            case "rate" -> handleRate(args);
            case "overview" -> handleOverview(args);
            case "quality" -> handleQuality(args);
            case "validate" -> handleValidate(args);
            case "diagram" -> handleDiagram(args);
            case "perspectives" -> handlePerspectives(args);
            case "merge-annotations" -> handleMergeAnnotations(args);
            case "audit-tree" -> handleAuditTree(args);
            default -> { System.err.println("Unknown: " + cmd); usage(); }
        }
    }

    static void usage() {
        System.err.println("""
            GraphCli <cmd> [args...]
            Commands:
              parse <project-root> <config-file> [output-file] [resolution]
              query <graph-file> <query> [scope]
              context <graph-file> <label>
              impact <graph-file> <label>
              subgraph <graph-file> <label> [depth]
              rate <graph-file> <task-description> [top-k]
              overview <graph-file>
              quality <graph-file>
              validate <graph-file>
              diagram <graph-file> <label> [depth]
              perspectives <graph-file> <out-dir> [max-elements]
              merge-annotations <graph-file> <tree-dir>
              audit-tree <graph-file> <tree-dir> [project-root]
            """);
    }

    static void handleParse(String[] args) throws IOException {
        if (args.length < 3) { usage(); return; }
        var projectRoot = Path.of(args[1]);
        var configFile = Path.of(args[2]);
        var outputFile = args.length > 3 ? Path.of(args[3]) : projectRoot.resolve("graph.json");
        double resolution = 1.0;
        if (args.length > 4) {
            try {
                resolution = Double.parseDouble(args[4]);
            } catch (NumberFormatException e) {
                System.err.println("Invalid resolution: " + args[4] + " (must be a number, e.g. 1.0)");
                return;
            }
        }

        var config = GraphPreprocessor.loadConfig(configFile);
        var processor = new GraphPreprocessor(config, projectRoot);
        var graph = processor.process();

        var leiden = CommunityDetector.detect(graph, 42L, resolution);
        var enhanced = new Graph(graph.project(), graph.nodes(), graph.edges(),
            graph.adjacency(), graph.reverseAdjacency(),
            leiden.communities(), leiden.summaries(), leiden.hierarchy());

        GraphQueryEngine.save(enhanced, outputFile);
        System.out.printf("Parsed: %d nodes, %d edges, %d communities (resolution=%.2f) → %s%n",
            graph.nodes().size(), graph.edges().size(),
            leiden.communities().size(), resolution, outputFile);
    }

    static void handleQuery(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var graph = GraphQueryEngine.load(graphFile);
        var query = args[2];
        var scope = args.length > 3 ? args[3] : null;

        var result = switch (query) {
            case "transitive-closure" -> GraphQueryEngine.queryTransitiveClosure(graph, scope);
            case "topo-sort" -> GraphQueryEngine.queryTopoSort(graph, scope);
            case "cycles" -> GraphQueryEngine.queryCycles(graph);
            case "community-summary" -> GraphQueryEngine.queryCommunity(graph, scope);
            case "contradictions", "contradiction-candidates" -> GraphQueryEngine.queryContradictionCandidates(graph, scope);
            case "impact" -> GraphQueryEngine.queryImpact(graph, scope);
            case "diagram" -> {
                int depth = 1;
                if (args.length > 4) {
                    try {
                        depth = Integer.parseInt(args[4]);
                    } catch (NumberFormatException e) {
                        System.out.println("Invalid depth: " + args[4] + " (must be an integer)");
                        yield null;
                    }
                }
                yield PerspectiveExporter.exportDiagram(graph, scope, depth);
            }
            default -> "Unknown query: " + query + "\nKnown: transitive-closure, topo-sort, cycles, community-summary, contradictions, impact, diagram";
        };
        System.out.println(result);
    }

    static void handleContext(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var label = args[2];

        var graph = GraphQueryEngine.load(graphFile);
        var ctx = GraphContextBuilder.buildTier1(graph, label, graph.project());
        System.out.println(ctx);
    }

    static void handleImpact(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var label = args[2];

        var graph = GraphQueryEngine.load(graphFile);
        var result = GraphQueryEngine.queryImpact(graph, label);
        System.out.println(result);
    }

    static void handleSubgraph(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var label = args[2];
        var depth = args.length > 3 ? Integer.parseInt(args[3]) : 1;

        var graph = GraphQueryEngine.load(graphFile);
        var result = GraphQueryEngine.querySubgraph(graph, label, depth);
        System.out.println(result);
    }

    static void handleRate(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var task = args[2];
        var topK = args.length > 3 ? Integer.parseInt(args[3]) : 5;

        var graph = GraphQueryEngine.load(graphFile);
        var result = GraphRater.rateRelevance(graph, task, topK);
        var output = GraphRater.formatRating(graph, result, task);
        System.out.println(output);
    }

    static void handleOverview(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var graph = GraphQueryEngine.load(graphFile);
        var overview = GraphContextBuilder.buildProjectOverview(graph);
        System.out.println(overview);
    }

    static void handleQuality(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var graph = GraphQueryEngine.load(graphFile);
        var quality = GraphQueryEngine.computeQualityMetrics(graph);
        System.out.println(quality);
    }

    static void handleValidate(String[] args) throws IOException {
        var graphFile = Path.of(args[1]);
        var graph = GraphQueryEngine.load(graphFile);
        var issues = GraphQueryEngine.validateSchema(graph);
        if (issues.isEmpty()) {
            System.out.println("Schema validation: PASSED — no issues found.");
        } else {
            System.out.println("Schema validation: " + issues.size() + " issue(s) found:\n");
            issues.forEach(System.out::println);
        }
    }

    static void handleDiagram(String[] args) throws IOException {
        if (args.length < 3) { usage(); return; }
        var graph = GraphQueryEngine.load(Path.of(args[1]));
        var depth = args.length > 3 ? Integer.parseInt(args[3]) : 1;
        System.out.println(PerspectiveExporter.exportDiagram(graph, args[2], depth));
    }

    static void handlePerspectives(String[] args) throws IOException {
        if (args.length < 3) { usage(); return; }
        var graph = GraphQueryEngine.load(Path.of(args[1]));
        var outDir = Path.of(args[2]);
        int maxElements = 32;
        if (args.length > 3) {
            try {
                maxElements = Integer.parseInt(args[3]);
            } catch (NumberFormatException e) {
                System.err.println("Invalid max-elements: " + args[3] + " (must be an integer)");
                return;
            }
        }
        System.out.println(PerspectiveExporter.exportPerspectives(graph, outDir, maxElements));
    }

    static void handleMergeAnnotations(String[] args) throws IOException {
        if (args.length < 3) { usage(); return; }
        var graphFile = Path.of(args[1]);
        var treeDir = Path.of(args[2]);
        var graph = GraphQueryEngine.load(graphFile);
        var result = PerspectiveExporter.mergeAnnotations(graph, treeDir);
        if (result.properties() > 0 || result.edges() > 0) {
            GraphQueryEngine.save(result.graph(), graphFile);
        }
        System.out.printf("Merged: %d element(s), %d node property update(s), %d edge(s) added%n",
            result.elements(), result.properties(), result.edges());
        if (!result.warnings().isEmpty()) {
            System.out.println("Warnings (" + result.warnings().size() + "):");
            result.warnings().stream().limit(20).forEach(w -> System.out.println("  " + w));
            if (result.warnings().size() > 20) {
                System.out.println("  ... and " + (result.warnings().size() - 20) + " more");
            }
        }
        System.out.println("Note: `parse` regenerates graph.json without annotations — re-run merge-annotations after a rebuild; the perspective tree is the durable source.");
    }

    static void handleAuditTree(String[] args) throws IOException {
        if (args.length < 3) { usage(); return; }
        var graph = GraphQueryEngine.load(Path.of(args[1]));
        var treeDir = Path.of(args[2]);
        var projectRoot = args.length > 3 ? Path.of(args[3]) : Path.of(args[1]).toAbsolutePath().getParent();
        var issues = PerspectiveExporter.auditTree(graph, treeDir, projectRoot);
        if (issues.isEmpty()) {
            System.out.println("Tree audit: PASSED — all element dirs anchored and current.");
        } else {
            System.out.println("Tree audit: " + issues.size() + " issue(s) found:\n");
            issues.forEach(System.out::println);
        }
    }
}
