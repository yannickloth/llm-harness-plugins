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
            default -> "Unknown query: " + query + "\nKnown: transitive-closure, topo-sort, cycles, community-summary, contradictions, impact";
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
}
