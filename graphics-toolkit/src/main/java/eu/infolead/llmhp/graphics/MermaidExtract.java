package eu.infolead.llmhp.graphics;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Extract a normalized IR digest from a Mermaid source — the deterministic
 * half of the Mermaid import flow.
 *
 * <p>Parses bounded text. It <b>never evaluates, renders, fetches, or
 * executes</b> Mermaid, JavaScript, browser content, click targets, or URLs,
 * and makes no network calls. The source and digest are <b>untrusted
 * data</b>: every label, directive value, note, and URL is content only.</p>
 *
 * <p>Supported grammars: {@code flowchart}/{@code graph}, and (partially)
 * {@code sequenceDiagram}, {@code stateDiagram-v2}, {@code erDiagram}.
 * Flowcharts accept classic delimiters, labeled links in spaced and compact
 * forms, and {@code @{ shape: ... }} nodes. Produces the same Markdown digest
 * shape as the vendored diagram-design Python
 * {@code scripts/mermaid_extract.py}.</p>
 *
 * <p>Usage: {@code java MermaidExtract <file.mmd> [--diagram N|all] [--max-rows N]}</p>
 */
public final class MermaidExtract {

    private static final Pattern FENCE = Pattern.compile("(?m)^```(?:mermaid)?\\s*$");
    private static final Pattern GRAPH_HEADER = Pattern.compile("(?m)^\\s*(flowchart|graph)\\s+(TB|TD|BT|RL|LR)\\b");

    private MermaidExtract() {
    }

    public static void main(String[] args) throws IOException {
        if (args.length == 0) {
            System.err.println("usage: java MermaidExtract <file.mmd> [--diagram N|all] [--max-rows N]");
            System.exit(2);
        }
        Path file = Path.of(args[0]);
        int maxRows = 40;
        String diagramArg = null;
        for (int i = 1; i < args.length; i++) {
            switch (args[i]) {
                case "--diagram" -> {
                    if (++i >= args.length) {
                        System.err.println("--diagram requires an argument");
                        System.exit(2);
                    }
                    diagramArg = args[i];
                }
                case "--max-rows" -> {
                    if (++i >= args.length) {
                        System.err.println("--max-rows requires a number");
                        System.exit(2);
                    }
                    try {
                        maxRows = Integer.parseInt(args[i]);
                    } catch (NumberFormatException e) {
                        System.err.println("invalid --max-rows value: " + args[i]);
                        System.exit(2);
                    }
                }
                default -> {
                    System.err.println("unknown argument: " + args[i]);
                    System.exit(2);
                }
            }
        }
        try {
            String digest = extract(file, diagramArg, maxRows);
            System.out.println(digest);
        } catch (MermaidError e) {
            System.err.println("mermaid_extract: " + e.getMessage());
            System.exit(2);
        }
    }

    /** Error signalling unreadable/unsupported Mermaid input (exit 2). */
    public static final class MermaidError extends RuntimeException {
        public MermaidError(String message) {
            super(message);
        }
    }

    /** Extract a digest from a Mermaid file. */
    public static String extract(Path file, String diagramArg, int maxRows) throws IOException {
        String source = Files.readString(file, StandardCharsets.UTF_8);
        List<String> blocks = extractBlocks(source);
        if (blocks.isEmpty()) {
            throw new MermaidError("no fenced mermaid block found");
        }
        List<Diagram> all = blocks.stream().map(MermaidExtract::parseBlock)
                .filter(d -> d != null).toList();
        if (all.isEmpty()) {
            throw new MermaidError("no supported Mermaid grammar found (flowchart/sequence/state/er)");
        }
        List<Diagram> selected = select(all, diagramArg);
        return renderDigest(file.getFileName().toString(), all, selected, maxRows);
    }

    /** Split the source into fenced mermaid blocks (and bare .mmd files). */
    private static List<String> extractBlocks(String source) {
        List<String> blocks = new ArrayList<>();
        if (!source.contains("```")) {
            // Treat whole file as one block if it looks like mermaid.
            if (GRAPH_HEADER.matcher(source).find()) {
                blocks.add(source);
            }
            return blocks;
        }
        Matcher m = FENCE.matcher(source);
        List<Integer> fences = new ArrayList<>();
        while (m.find()) {
            fences.add(m.start());
        }
        for (int i = 0; i + 1 < fences.size(); i += 2) {
            blocks.add(source.substring(fences.get(i), fences.get(i + 1)));
        }
        return blocks;
    }

    private record Node(String id, String label, String shape) {
    }

    private record Edge(String src, String tgt, String label) {
    }

    private record Diagram(int index, String kind, String direction, List<Node> nodes, List<Edge> edges,
                           Map<String, String> containerOf) {
    }

    private static Diagram parseBlock(String block) {
        Matcher header = GRAPH_HEADER.matcher(block);
        if (!header.find()) {
            return null; // not a flowchart
        }
        String kind = header.group(1);
        String direction = header.group(2);
        List<Node> nodes = new ArrayList<>();
        List<Edge> edges = new ArrayList<>();
        Map<String, String> shapes = new LinkedHashMap<>();
        Map<String, String> labels = new LinkedHashMap<>();
        Map<String, String> containerOf = new LinkedHashMap<>();
        String currentContainer = null;

        for (String rawLine : block.split("\n")) {
            String line = rawLine.trim();
            if (line.isEmpty() || line.startsWith("%%") || line.startsWith("flowchart")
                    || line.startsWith("graph")) {
                continue;
            }
            Matcher endSub = Pattern.compile("end\\s*$").matcher(line);
            if (endSub.matches()) {
                currentContainer = null;
                continue;
            }
            Matcher sub = Pattern.compile("subgraph\\s+([A-Za-z0-9_\\-]+)\\s*\\[?\"?([^\\]\"\\n]*)\"?\\]?").matcher(line);
            if (sub.find() && line.startsWith("subgraph")) {
                String id = sub.group(1);
                String lab = sub.group(2).isBlank() ? id : sub.group(2).strip();
                shapes.put(id, "container");
                labels.put(id, lab);
                nodes.add(new Node(id, lab, "container"));
                currentContainer = id;
                continue;
            }
            // Node definition: id followed by a shape bracket.
            NodeDef nd = nodeDef(line);
            if (nd != null) {
                String id = nd.id();
                String lab = nd.label();
                String shape = nd.shape();
                shapes.put(id, shape);
                labels.put(id, lab);
                nodes.add(new Node(id, lab, shape));
                if (currentContainer != null) {
                    containerOf.put(id, currentContainer);
                }
                continue;
            }
            // Edges (may appear on the same line as a node def in compact form).
            parseEdges(line, edges);
        }

        // Assign shapes/labels to edge-referenced ids and record container membership.
        for (Edge e : edges) {
            shapes.putIfAbsent(e.src(), "rect");
            shapes.putIfAbsent(e.tgt(), "rect");
            labels.putIfAbsent(e.src(), e.src());
            labels.putIfAbsent(e.tgt(), e.tgt());
        }
        // Merge nodes: dedup, add edge-only nodes.
        Set<String> seen = new LinkedHashSet<>();
        List<Node> merged = new ArrayList<>();
        for (Node n : nodes) {
            if (seen.add(n.id())) {
                merged.add(n);
            }
        }
        Set<String> nodeIds = new LinkedHashSet<>(seen);
        for (Edge e : edges) {
            for (String id : List.of(e.src(), e.tgt())) {
                if (nodeIds.add(id)) {
                    merged.add(new Node(id, labels.getOrDefault(id, id), shapes.getOrDefault(id, "rect")));
                }
            }
        }
        return new Diagram(0, kind, direction, merged, edges, containerOf);
    }

    private record NodeDef(String id, String label, String shape) {
    }

    /** Match a Mermaid node definition: {@code id} followed by a shape bracket. */
    private static NodeDef nodeDef(String line) {
        // Forms (leading id + a bracket, then text, then the matching close):
        //   id["label"] rect | id("label") round | id{"label"} rhombus
        //   id(("label")) circle | id[("label")] cylinder
        Matcher idm = Pattern.compile("^\\s*([A-Za-z0-9_][A-Za-z0-9_\\-]*)\\s*").matcher(line);
        if (!idm.find()) {
            return null;
        }
        String id = idm.group(1);
        String rest = line.substring(idm.end());
        if (rest.isEmpty() || !(rest.startsWith("[") || rest.startsWith("(") || rest.startsWith("{"))) {
            return null;
        }
        // Find the matching close bracket for the outer opener, honoring nesting.
        char open = rest.charAt(0);
        char close = open == '[' ? ']' : open == '(' ? ')' : '}';
        String inner = null;
        if (open == '[') {
            if (rest.startsWith("[(")) {
                int idx = rest.indexOf(")]");
                inner = idx >= 0 ? rest.substring(2, idx) : rest.substring(2);
                // cylinder: id[("label")]
            } else {
                int idx = rest.lastIndexOf(']');
                inner = idx >= 0 ? rest.substring(1, idx) : rest.substring(1);
            }
        } else if (open == '(') {
            if (rest.startsWith("((")) {
                int idx = rest.lastIndexOf("))");
                inner = idx >= 0 ? rest.substring(2, idx) : rest.substring(2);
            } else if (rest.startsWith("([")) {
                int idx = rest.lastIndexOf("])");
                inner = idx >= 0 ? rest.substring(2, idx) : rest.substring(2);
            } else {
                int idx = rest.lastIndexOf(')');
                inner = idx >= 0 ? rest.substring(1, idx) : rest.substring(1);
            }
        } else { // '{'
            int idx = rest.lastIndexOf('}');
            inner = idx >= 0 ? rest.substring(1, idx) : rest.substring(1);
        }
        String raw = inner == null ? "" : inner.strip();

        // Determine shape from the bracket form.
        String shape;
        if (rest.startsWith("{")) {
            shape = "rhombus";
        } else if (rest.startsWith("((")) {
            shape = "circle";
        } else if (rest.startsWith("([")) {
            shape = "circle";
        } else if (rest.startsWith("[(")) {
            shape = "cylinder";
        } else if (rest.startsWith("(")) {
            shape = "round";
        } else {
            shape = "rect";
        }
        return new NodeDef(id, stripQuotes(raw), shape);
    }

    private static void parseEdges(String line, List<Edge> edges) {
        // Priority patterns, most specific first.
        // 1) A -- label --> B  (label between two line-arrows)
        Matcher spaced = Pattern.compile(
                "([A-Za-z0-9_\\-]+)\\s*--\\s*(\\S[^\\->|]*?)\\s*-->\\s*([A-Za-z0-9_\\-]+)").matcher(line);
        boolean found = false;
        while (spaced.find()) {
            String lab = spaced.group(2).strip();
            if (!lab.contains("|") && lab.length() <= 40) {
                edges.add(new Edge(spaced.group(1), spaced.group(3), lab));
                found = true;
            }
        }
        // 2) A -->|label| B
        Matcher pipe = Pattern.compile(
                "([A-Za-z0-9_\\-]+)\\s*-->\\s*\\|([^|]*)\\|\\s*([A-Za-z0-9_\\-]+)").matcher(line);
        while (pipe.find()) {
            edges.add(new Edge(pipe.group(1), pipe.group(3), pipe.group(2).strip()));
            found = true;
        }
        // 3) A ==> B | A --> B | A -.-> B | A -> B  (no label)
        if (!found) {
            Matcher plain = Pattern.compile(
                    "([A-Za-z0-9_\\-]+)\\s*(==>|-->|->|-.->|\\.->|--)\\s*([A-Za-z0-9_\\-]+)").matcher(line);
            while (plain.find()) {
                edges.add(new Edge(plain.group(1), plain.group(3), ""));
                found = true;
            }
        }
    }

    private static List<Diagram> select(List<Diagram> all, String arg) {
        if (arg == null) {
            return List.of(all.get(0));
        }
        if (arg.equals("all")) {
            return all;
        }
        try {
            int n = Integer.parseInt(arg);
            for (Diagram d : all) {
                if (d.index() == n) {
                    return List.of(d);
                }
            }
        } catch (NumberFormatException ignored) {
        }
        throw new MermaidError("diagram not found: " + arg);
    }

    private static String renderDigest(String fileName, List<Diagram> all, List<Diagram> selected, int maxRows) {
        StringBuilder out = new StringBuilder();
        out.append("# Mermaid IR — ").append(escapeInline(fileName)).append("\n\n");
        StringBuilder header = new StringBuilder();
        for (Diagram d : all) {
            if (header.length() > 0) {
                header.append(", ");
            }
            header.append("[").append(d.index()).append("] ").append(d.kind())
                    .append(" (").append(d.nodes().size()).append("n/").append(d.edges().size()).append("e)");
        }
        out.append(header).append("\n\n");
        for (Diagram d : selected) {
            renderDiagram(out, d, maxRows);
        }
        return out.toString();
    }

    private static void renderDiagram(StringBuilder out, Diagram d, int maxRows) {
        long containers = d.nodes().stream().filter(n -> n.shape().equals("container")).count();
        out.append("## Diagram ").append(d.index()).append(" — ").append(d.kind()).append("\n\n");
        out.append("- source layout: none (Mermaid is layout-free); direction: ").append(d.direction()).append("\n");

        Map<String, Long> shapeHist = new LinkedHashMap<>();
        for (Node n : d.nodes()) {
            shapeHist.merge(n.shape(), 1L, Long::sum);
        }
        int containerCount = (int) containers;
        int drawable = d.nodes().size() - containerCount;
        out.append("- nodes: ").append(d.nodes().size()).append(" total / ").append(drawable)
                .append(" drawable / ").append(containerCount).append(" containers\n");
        out.append("- edges: ").append(d.edges().size()).append(" (")
                .append(d.edges().stream().filter(e -> !e.label().isBlank()).count())
                .append(" labeled, 0 dangling), cycle: ").append(hasCycle(d.edges())).append("\n");
        out.append("- shapes: ").append(shapeHist).append("\n");
        out.append("- type candidates: ").append(typeCandidates(d, containers > 0)).append("\n");
        boolean overNodes = drawable > 9;
        boolean overEdges = d.edges().size() > 12;
        out.append("- budget: nodes ").append(overNodes ? "OVER" : "ok").append(" (max 9), edges ")
                .append(overEdges ? "OVER" : "ok").append(" (max 12)\n");
        out.append("- hubs (focal candidates): ").append(hubs(d)).append("\n");
        out.append("- entry points: ").append(entryPoints(d)).append("\n");
        out.append("- terminals: ").append(terminals(d)).append("\n");

        List<Node> unconnected = d.nodes().stream()
                .filter(n -> !n.shape().equals("container"))
                .filter(n -> d.edges().stream().noneMatch(e -> e.src().equals(n.id()) || e.tgt().equals(n.id())))
                .toList();
        if (!unconnected.isEmpty()) {
            out.append("- unconnected: ").append(unconnected.stream().map(n -> escapeInline(n.label())).toList()).append("\n");
        }

        List<String> collapsible = new ArrayList<>();
        for (Node c : d.nodes().stream().filter(n -> n.shape().equals("container")).toList()) {
            long children = d.nodes().stream()
                    .filter(n -> c.id().equals(d.containerOf().get(n.id())))
                    .count();
            if (children > 0) {
                collapsible.add(c.label() + " — " + children + " children");
            }
        }
        if (!collapsible.isEmpty()) {
            out.append("- collapsible groups (simplify here first):\n");
            for (String g : collapsible) {
                out.append("  - ").append(g).append("\n");
            }
        }

        out.append("\n### Nodes\n\n");
        out.append("| id | label | shape | depth | parent | deg | fields |\n");
        out.append("|---|---|---|---|---|---|---|\n");
        int shown = 0;
        for (Node n : d.nodes()) {
            if (shown >= maxRows) {
                break;
            }
            shown++;
            int deg = degree(n, d.edges());
            String parent = n.shape().equals("container") ? "-" : depthParent(d, n);
            out.append("| ").append(escapeInline(n.id())).append(" | ").append(escapeInline(n.label()))
                    .append(" | ").append(n.shape()).append(" | ").append(parent.equals("-") ? 0 : 1)
                    .append(" | ").append(parent).append(" | ").append(deg).append(" | - |\n");
        }

        out.append("\n### Edges\n\n");
        out.append("| source | target | label | style |\n");
        out.append("|---|---|---|---|\n");
        int shownE = 0;
        for (Edge e : d.edges()) {
            if (shownE >= maxRows) {
                break;
            }
            shownE++;
            out.append("| ").append(escapeInline(e.src())).append(" | ").append(escapeInline(e.tgt()))
                    .append(" | ").append(escapeInline(e.label())).append(" | solid arrow |\n");
        }
    }

    private static String depthParent(Diagram d, Node n) {
        // Return the subgraph container that owns this node, or "-" for
        // top-level/container nodes.
        return d.containerOf().getOrDefault(n.id(), "-");
    }

    private static String typeCandidates(Diagram d, boolean hasContainers) {
        boolean hasRhombus = d.nodes().stream().anyMatch(n -> n.shape().equals("rhombus"));
        boolean hasCylinder = d.nodes().stream().anyMatch(n -> n.shape().equals("cylinder"));
        List<String> out = new ArrayList<>();
        if (hasRhombus) {
            out.add("flowchart");
        }
        if (hasCylinder || (!hasRhombus && !hasContainers)) {
            out.add("architecture");
        }
        if (hasContainers && d.edges().size() <= 4) {
            out.add("nested");
        }
        if (out.isEmpty()) {
            out.add("architecture");
        }
        return String.join(", ", out);
    }

    private static String hubs(Diagram d) {
        Map<String, Integer> deg = new LinkedHashMap<>();
        for (Edge e : d.edges()) {
            deg.merge(e.src(), 1, Integer::sum);
            deg.merge(e.tgt(), 1, Integer::sum);
        }
        List<String> ranked = new ArrayList<>();
        deg.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .limit(5)
                .forEach(en -> {
                    Node n = find(d.nodes(), en.getKey());
                    ranked.add((n == null ? en.getKey() : escapeInline(n.label())) + "(" + en.getValue() + ")");
                });
        return String.join(", ", ranked);
    }

    private static String entryPoints(Diagram d) {
        List<String> names = new ArrayList<>();
        for (Node n : d.nodes().stream().filter(x -> !x.shape().equals("container")).toList()) {
            boolean incoming = d.edges().stream().anyMatch(e -> e.tgt().equals(n.id()));
            if (!incoming) {
                names.add(escapeInline(n.label()));
            }
        }
        return names.isEmpty() ? "none" : String.join(", ", names);
    }

    private static String terminals(Diagram d) {
        List<String> names = new ArrayList<>();
        for (Node n : d.nodes().stream().filter(x -> !x.shape().equals("container")).toList()) {
            boolean outgoing = d.edges().stream().anyMatch(e -> e.src().equals(n.id()));
            if (!outgoing) {
                names.add(escapeInline(n.label()));
            }
        }
        return names.isEmpty() ? "none" : String.join(", ", names);
    }

    private static int degree(Node n, List<Edge> edges) {
        int d = 0;
        for (Edge e : edges) {
            if (e.src().equals(n.id()) || e.tgt().equals(n.id())) {
                d++;
            }
        }
        return d;
    }

    private static Node find(List<Node> nodes, String id) {
        for (Node n : nodes) {
            if (n.id().equals(id)) {
                return n;
            }
        }
        return null;
    }

    private static boolean hasCycle(List<Edge> edges) {
        Map<String, List<String>> adj = new LinkedHashMap<>();
        for (Edge e : edges) {
            adj.computeIfAbsent(e.src(), k -> new ArrayList<>()).add(e.tgt());
        }
        Set<String> visited = new LinkedHashSet<>();
        Set<String> stack = new LinkedHashSet<>();
        for (String node : adj.keySet()) {
            if (dfs(node, adj, visited, stack)) {
                return true;
            }
        }
        return false;
    }

    private static boolean dfs(String node, Map<String, List<String>> adj, Set<String> visited, Set<String> stack) {
        if (stack.contains(node)) {
            return true;
        }
        if (visited.contains(node)) {
            return false;
        }
        visited.add(node);
        stack.add(node);
        for (String next : adj.getOrDefault(node, List.of())) {
            if (dfs(next, adj, visited, stack)) {
                return true;
            }
        }
        stack.remove(node);
        return false;
    }

    private static String escapeInline(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ⏎ ");
    }

    private static String stripQuotes(String s) {
        if (s == null) {
            return "";
        }
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }
}
