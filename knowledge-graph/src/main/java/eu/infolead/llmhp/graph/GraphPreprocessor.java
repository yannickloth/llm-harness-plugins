package eu.infolead.llmhp.graph;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;
import eu.infolead.llmhp.graph.types.*;

public final class GraphPreprocessor {

    private final ProjectConfig config;
    private final Path projectRoot;
    private final Map<String, Node> nodes = new LinkedHashMap<>();
    private final List<Edge> edges = new ArrayList<>();
    private final Map<String, List<String>> includeTree = new LinkedHashMap<>();
    private final Map<String, List<String>> includeReverse = new LinkedHashMap<>();
    private final List<Pattern> labelPatterns = new ArrayList<>();

    public GraphPreprocessor(ProjectConfig config, Path projectRoot) {
        this.config = config;
        this.projectRoot = projectRoot;
        for (var rule : config.labelRules()) {
            labelPatterns.add(Pattern.compile(rule.regex()));
        }
    }

    public Graph process() throws IOException {
        var allTypFiles = findAllTypFiles();
        phase1LabelScan(allTypFiles);
        phase2IncludeResolve(allTypFiles);
        phase3StructuralContext();
        phase4DependencyExtract(allTypFiles);
        phase5NamedRelations();
        phase6CrossReferenceExpand();

        var adj = new HashMap<String, List<String>>();
        var revAdj = new HashMap<String, List<String>>();
        for (var e : edges) {
            adj.computeIfAbsent(e.source(), k -> new ArrayList<>()).add(e.target());
            revAdj.computeIfAbsent(e.target(), k -> new ArrayList<>()).add(e.source());
        }

        return new Graph(config.project(), nodes, edges, adj, revAdj,
            Map.of(), Map.of(), Map.of());
    }

    public static ProjectConfig loadConfig(Path configFile) throws IOException {
        var content = Files.readString(configFile);
        return parseYamlConfig(content);
    }

    private List<Path> findAllTypFiles() throws IOException {
        var result = new ArrayList<Path>();
        try (var files = Files.walk(projectRoot)) {
            files.filter(f -> f.toString().endsWith(".typ") && !f.toString().contains("/.git/"))
                .forEach(result::add);
        }
        return result;
    }

    private void phase1LabelScan(List<Path> files) throws IOException {
        var rawLabels = new LinkedHashSet<String>();

        for (var file : files) {
            var content = Files.readString(file);
            var relPath = projectRoot.relativize(file).toString();

            for (int li = 0; li < labelPatterns.size(); li++) {
                var matcher = labelPatterns.get(li).matcher(content);
                var rule = config.labelRules().get(li);
                while (matcher.find()) {
                    String label;
                    try {
                        label = matcher.group(1).trim();
                    } catch (IndexOutOfBoundsException | IllegalStateException e) {
                        continue;
                    }
                    if (label.isEmpty() || label.contains(" ")) continue;

                    String fullId;
                    if (rule.type().equals("label_raw")) {
                        fullId = label;
                    } else if (label.contains(":")) {
                        fullId = label;
                    } else {
                        fullId = rule.type() + ":" + label;
                    }

                    if (!nodes.containsKey(fullId)) {
                        var line = contentBeforeLine(content, matcher.start());
                        var props = new LinkedHashMap<>(rule.defaults());
                        props.put("line", String.valueOf(line));
                        props.put("file", relPath);
                        String name = label;
                        if (matcher.groupCount() >= 2) {
                            try {
                                var g2 = matcher.group(2);
                                if (g2 != null) name = g2.trim();
                            } catch (IndexOutOfBoundsException | IllegalStateException ignored) {}
                        }
                        props.put("name", name);
                        nodes.put(fullId, new Node(fullId, rule.type(), name, relPath, String.valueOf(line), props));
                    }
                    rawLabels.add(fullId);
                }
            }
        }

        addProjectStructuralNodes(files);
    }

    private void addProjectStructuralNodes(List<Path> files) {
        var projectNode = new Node("prj:" + config.project().replaceAll("[^a-zA-Z0-9_-]", "-"),
            "project", config.project(), "", "0", Map.of());
        nodes.putIfAbsent(projectNode.id(), projectNode);

        var dirs = new LinkedHashSet<String>();
        for (var f : files) {
            var rel = projectRoot.relativize(f).toString();
            var parts = rel.split("/");
            var accum = new StringBuilder();
            for (int i = 0; i < Math.min(parts.length, 4); i++) {
                if (!accum.isEmpty()) accum.append("/");
                accum.append(parts[i]);
                dirs.add(accum.toString());
            }
        }

        var dirNodes = new LinkedHashMap<String, Node>();
        for (var d : dirs) {
            var depth = d.split("/").length;
            var type = switch (depth) {
                case 1 -> "volume";
                case 2 -> "chapter";
                case 3 -> "section";
                default -> "subsection";
            };
            var prefix = switch (type) {
                case "volume" -> "vol:";
                case "chapter" -> "ch:";
                case "section" -> "sec:";
                default -> "subsec:";
            };
            var id = prefix + d.replace("/", "-").replace(" ", "-").toLowerCase();
            var node = new Node(id, type, d, d, "0", Map.of("path", d));
            nodes.putIfAbsent(id, node);
            dirNodes.put(d, node);
        }

        for (var file : files) {
            var rel = projectRoot.relativize(file).toString();
            var dir = rel.contains("/") ? rel.substring(0, rel.lastIndexOf('/')) : "";
            var fileNode = new Node("file:" + rel.replaceAll("[^a-zA-Z0-9_/.-]", "_"),
                "file", rel, rel, "0", Map.of("path", rel));
            nodes.putIfAbsent(fileNode.id(), fileNode);
            if (!dir.isEmpty() && dirNodes.containsKey(dir)) {
                edges.add(new Edge(fileNode.id(), dirNodes.get(dir).id(), "appears_in", Map.of()));
            }
        }
    }

    private int contentBeforeLine(String content, int position) {
        var lines = content.substring(0, Math.min(position, content.length())).split("\n", -1);
        return lines.length;
    }

    private void phase2IncludeResolve(List<Path> files) throws IOException {
        var includePattern = Pattern.compile("#(include|import)\\s+\"([^\"]+)\"");

        for (var file : files) {
            var content = Files.readString(file);
            var relPath = projectRoot.relativize(file).toString();
            var fileNode = "file:" + pathToNode(relPath);
            var matcher = includePattern.matcher(content);

            while (matcher.find()) {
                var included = matcher.group(2).trim();
                var resolved = resolveInclude(file, included);
                if (resolved == null) continue;
                var relIncluded = projectRoot.relativize(resolved).toString();
                var includedNode = "file:" + pathToNode(relIncluded);

                includeTree.computeIfAbsent(fileNode, k -> new ArrayList<>()).add(includedNode);
                includeReverse.computeIfAbsent(includedNode, k -> new ArrayList<>()).add(fileNode);
                edges.add(new Edge(fileNode, includedNode, "includes", Map.of()));
            }
        }

        var includeCycles = detectIncludeCycles();
        if (!includeCycles.isEmpty()) {
            System.err.println("WARNING: include cycles detected:");
            for (var cycle : includeCycles) {
                System.err.println("  " + String.join(" → ", cycle));
            }
        }
    }

    private List<List<String>> detectIncludeCycles() {
        var cycles = new ArrayList<List<String>>();
        for (var file : includeTree.keySet()) {
            var path = new ArrayList<String>();
            var visited = new HashSet<String>();
            findIncludeCycle(file, file, path, visited, cycles, 100);
        }
        return cycles;
    }

    private void findIncludeCycle(String start, String current, List<String> path,
            Set<String> visited, List<List<String>> cycles, int maxDepth) {
        if (path.size() > maxDepth) return;
        path.add(current);
        visited.add(current);
        for (var next : includeTree.getOrDefault(current, List.of())) {
            if (next.equals(start) && path.size() > 1) {
                cycles.add(new ArrayList<>(path));
            } else if (!visited.contains(next)) {
                findIncludeCycle(start, next, path, visited, cycles, maxDepth);
            }
        }
        path.removeLast();
        visited.remove(current);
    }

    private Path resolveInclude(Path sourceFile, String included) {
        var sourceDir = sourceFile.getParent();
        var direct = sourceDir.resolve(included).normalize();
        if (Files.exists(direct)) return direct;
        var withExt = sourceDir.resolve(included + ".typ").normalize();
        if (Files.exists(withExt)) return withExt;
        return null;
    }

    private void phase3StructuralContext() {
        var dagWithoutCycles = detectAndBreakCycles();

        for (var node : nodes.values()) {
            if (!node.id().startsWith("file:")) continue;
            var chain = walkIncludesUp(node.id(), dagWithoutCycles);
            for (var ancestor : chain) {
                if (!nodes.containsKey(ancestor)) continue;
                edges.add(new Edge(node.id(), ancestor, "appears_in", Map.of()));
            }
        }
    }

    private Set<String> walkIncludesUp(String fileNode, Map<String, Set<String>> dag) {
        var chain = new LinkedHashSet<String>();
        var queue = new ArrayDeque<String>();
        var visited = new HashSet<String>();
        queue.add(fileNode);
        while (!queue.isEmpty()) {
            var current = queue.poll();
            if (!visited.add(current)) continue;
            for (var parent : dag.getOrDefault(current, Set.of())) {
                if (parent.startsWith("vol:") || parent.startsWith("ch:") ||
                    parent.startsWith("sec:") || parent.startsWith("subsec:") ||
                    parent.startsWith("part:") || parent.startsWith("prj:")) {
                    chain.add(parent);
                } else if (parent.startsWith("file:")) {
                    queue.add(parent);
                }
            }
        }
        return chain;
    }

    private Map<String, Set<String>> detectAndBreakCycles() {
        var dag = new HashMap<String, Set<String>>();
        for (var e : includeTree.entrySet()) {
            dag.put(e.getKey(), new LinkedHashSet<>(e.getValue()));
        }
        for (var node : nodes.values()) {
            if (node.id().startsWith("vol:") || node.id().startsWith("ch:") ||
                node.id().startsWith("sec:") || node.id().startsWith("subsec:") ||
                node.id().startsWith("part:") || node.id().startsWith("prj:")) {
                dag.putIfAbsent(node.id(), new LinkedHashSet<>());
            }
        }
        return dag;
    }

    private void phase4DependencyExtract(List<Path> files) throws IOException {
        var refPattern = Pattern.compile("@([a-zA-Z][a-zA-Z0-9_-]+(?:[.:@][a-zA-Z][a-zA-Z0-9_-]+)*)");

        for (var file : files) {
            var content = Files.readString(file);
            var relPath = projectRoot.relativize(file).toString();
            var matcher = refPattern.matcher(content);

            while (matcher.find()) {
                var ref = matcher.group(1);
                String fullRef = null;
                for (var prefix : List.of("def:", "thm:", "lem:", "prop:", "cor:", "axm:", "asm:",
                        "proof:", "rem:", "ex:", "ki:", "cex:", "obs:",
                        "hyp:", "mech:", "bio:", "drug:", "trt:", "sx:", "cit:",
                        "causal:", "model:", "var:", "spec:", "prot:", "pat:",
                        "fig:", "tab:", "sym:", "ch:", "sec:", "subsec:", "vol:", "part:")) {
                    var candidate = prefix + ref;
                    if (nodes.containsKey(candidate)) {
                        fullRef = candidate;
                        break;
                    }
                }
                if (fullRef == null) {
                    var candidate = "def:" + ref;
                    if (nodes.containsKey(candidate)) fullRef = candidate;
                }
                if (fullRef == null) continue;

                var sourceNode = findParentNodeForFile(relPath);
                if (sourceNode != null && !sourceNode.equals(fullRef)) {
                    edges.add(new Edge(sourceNode, fullRef, "depends_on", Map.of(
                        "file", relPath,
                        "implicit", "false"
                    )));
                }
            }
        }
    }

    private String findParentNodeForFile(String relPath) {
        var fileNode = "file:" + pathToNode(relPath);
        if (nodes.containsKey(fileNode)) return fileNode;

        for (var node : nodes.values()) {
            if (node.file().equals(relPath) && !node.id().startsWith("file:")) {
                return node.id();
            }
        }
        return fileNode;
    }

    private void phase5NamedRelations() {
        var conventions = config.namingConventions();
        if (conventions == null) return;

        for (var conv : conventions.entrySet()) {
            var parts = conv.getKey().split("→");
            if (parts.length != 2) continue;
            var fromType = parts[0].trim();
            var toType = parts[1].trim();
            var edgeType = conv.getValue().getFirst();

            for (var node : nodes.values()) {
                if (!node.type().equals(fromType)) continue;
                for (var targetNode : nodes.values()) {
                    if (!targetNode.type().equals(toType)) continue;
                    if (node.name().equals(targetNode.name())) {
                        edges.add(new Edge(node.id(), targetNode.id(), edgeType, Map.of()));
                    }
                }
            }
        }
    }

    private void phase6CrossReferenceExpand() {
        var transitiveIncludes = new HashMap<String, Set<String>>();
        for (var node : nodes.values()) {
            if (!node.id().startsWith("file:")) continue;
            var reachable = new LinkedHashSet<String>();
            var queue = new ArrayDeque<String>();
            queue.add(node.id());
            while (!queue.isEmpty()) {
                var f = queue.poll();
                if (!reachable.add(f)) continue;
                for (var included : includeTree.getOrDefault(f, List.of())) {
                    if (!reachable.contains(included)) queue.add(included);
                }
            }
            transitiveIncludes.put(node.id(), reachable);
        }

        var expandedEdges = new ArrayList<Edge>();
        for (var e : edges) {
            if (!e.type().equals("depends_on")) continue;
            var sourceFile = e.properties().get("file");
            if (sourceFile == null || sourceFile.isEmpty()) continue;
            var sourceFileNode = "file:" + pathToNode(sourceFile);
            var reachable = transitiveIncludes.get(sourceFileNode);
            if (reachable == null) continue;

            for (var inc : reachable) {
                if (inc.equals(sourceFileNode)) continue;
                expandedEdges.add(new Edge(e.source(), e.target(), "cross_references", Map.of(
                    "via", inc,
                    "original_file", sourceFile
                )));
            }
        }
        edges.addAll(expandedEdges);
    }

    private String pathToNode(String path) {
        return path.replaceAll("[^a-zA-Z0-9_/.-]", "_").replace("/", "_").replace(".", "_");
    }

    private static ProjectConfig parseYamlConfig(String content) {
        var lines = content.split("\n");
        var project = "";
        var labelRules = new ArrayList<ProjectConfig.LabelRule>();
        var edgeRules = new ArrayList<ProjectConfig.EdgeRule>();
        var namingConventions = new LinkedHashMap<String, List<String>>();
        var structuralPrefixes = new ArrayList<String>();

        var section = "";
        var currentMap = new LinkedHashMap<String, String>();

        for (var line : lines) {
            var trimmed = line.strip();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;

            if (trimmed.equals("label_rules:") || trimmed.equals("edge_rules:") ||
                trimmed.equals("naming_conventions:") || trimmed.equals("structural_prefixes:")) {
                flushCurrent(labelRules, edgeRules, section, currentMap);
                section = trimmed.replace(":", "");
                continue;
            }

            if (trimmed.equals("project:")) { section = "project"; continue; }

            switch (section) {
                case "project" -> {
                    var entry = parseKeyValue(trimmed);
                    if (entry != null && entry.getKey().equals("name"))
                        project = entry.getValue();
                }
                case "label_rules", "edge_rules" -> {
                    if (trimmed.startsWith("-")) {
                        flushCurrent(labelRules, edgeRules, section, currentMap);
                        currentMap.clear();
                        var rest = trimmed.substring(1).strip();
                        var entry = parseKeyValue(rest);
                        if (entry != null) currentMap.put(entry.getKey(), entry.getValue());
                    } else {
                        var entry = parseKeyValue(trimmed);
                        if (entry != null) currentMap.put(entry.getKey(), entry.getValue());
                    }
                }
                case "naming_conventions" -> {
                    var match = Pattern.compile("^([a-zA-Z_]+→[a-zA-Z_]+):\\s*\\[(.+)\\]$").matcher(trimmed);
                    if (match.find()) {
                        var rel = match.group(1);
                        var types = match.group(2).replace("\"", "").split(",\\s*");
                        namingConventions.put(rel, List.of(types));
                    }
                }
                case "structural_prefixes" -> {
                    var match = Pattern.compile("^\\s*-\\s*\"?([a-zA-Z_]+)\"?$").matcher(trimmed);
                    if (match.find()) structuralPrefixes.add(match.group(1));
                }
            }
        }
        flushCurrent(labelRules, edgeRules, section, currentMap);

        if (labelRules.isEmpty()) {
            labelRules.add(new ProjectConfig.LabelRule(
                "<([a-zA-Z][a-zA-Z0-9_-]+)>", "def", Map.of()));
            labelRules.add(new ProjectConfig.LabelRule(
                "@([a-zA-Z][a-zA-Z0-9_-]+(?:[.:@][a-zA-Z][a-zA-Z0-9_-]+)*)", "ref", Map.of()));
        }

        return new ProjectConfig(project, labelRules, edgeRules, namingConventions, structuralPrefixes);
    }

    private static void flushCurrent(ArrayList<ProjectConfig.LabelRule> labelRules,
                                      ArrayList<ProjectConfig.EdgeRule> edgeRules,
                                      String section, Map<String, String> map) {
        if (map.isEmpty()) return;
        switch (section) {
            case "label_rules" -> labelRules.add(new ProjectConfig.LabelRule(
                map.getOrDefault("regex", ""),
                map.getOrDefault("type", ""),
                new LinkedHashMap<>()));
            case "edge_rules" -> edgeRules.add(new ProjectConfig.EdgeRule(
                map.getOrDefault("from", ""), map.getOrDefault("to", ""),
                map.getOrDefault("type", ""), map.getOrDefault("description", "")));
        }
    }

    private static AbstractMap.SimpleEntry<String, String> parseKeyValue(String line) {
        var colonIdx = line.indexOf(':');
        if (colonIdx < 0) return null;
        var key = line.substring(0, colonIdx).strip();
        var rawValue = line.substring(colonIdx + 1).strip();

        String value = rawValue;
        if (rawValue.length() >= 2) {
            var first = rawValue.charAt(0);
            var last = rawValue.charAt(rawValue.length() - 1);
            if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
                value = rawValue.substring(1, rawValue.length() - 1);
            }
        }

        if (value.startsWith(">-") || value.startsWith(">") || value.startsWith("|")) return null;

        return new AbstractMap.SimpleEntry<>(key, value);
    }
}
