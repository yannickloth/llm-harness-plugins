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

    private static final Pattern REF_PATTERN_1B = Pattern.compile("[@<]([a-zA-Z][a-zA-Z0-9_-]+(?:[.:@][a-zA-Z][a-zA-Z0-9_-]+)*)[>]?");
    private static final Pattern INCLUDE_PATTERN = Pattern.compile("#(include|import)\\s+\"([^\"]+)\"");
    private static final Pattern REF_PATTERN_2 = Pattern.compile("@([a-zA-Z][a-zA-Z0-9_-]+(?:[.:@][a-zA-Z][a-zA-Z0-9_-]+)*)");
    private static final Pattern NAMING_CONV_PATTERN = Pattern.compile("^([a-zA-Z_]+→[a-zA-Z_]+):\\s*\\[(.+)\\]$");
    private static final Pattern STRUCTURAL_PREFIX_PATTERN = Pattern.compile("^\\s*-\\s*\"?([a-zA-Z_]+)\"?$");

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
        phase1bReferenceScan(allTypFiles);
        phase2IncludeResolve(allTypFiles);
        phase3StructuralContext();
        phase4DependencyExtract(allTypFiles);
        phase5NamedRelations();
        phase6CrossReferenceExpand();
        phase7EntityResolution();

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
                    } else {
                        var existing = nodes.get(fullId);
                        var existingFiles = existing.property("files");
                        var updatedFiles = existingFiles.isEmpty() ? existing.file() + ";; " + relPath
                            : existingFiles + ";; " + relPath;
                        var merged = new LinkedHashMap<>(existing.properties());
                        merged.put("files", updatedFiles);
                        nodes.put(fullId, new Node(fullId, existing.type(), existing.name(),
                            existing.file(), existing.line(), merged));
                    }
                    rawLabels.add(fullId);
                }
            }
        }

        addProjectStructuralNodes(files);
    }

    private void phase1bReferenceScan(List<Path> files) throws IOException {
        for (var file : files) {
            var content = Files.readString(file);
            var relPath = projectRoot.relativize(file).toString();

            var matcher = REF_PATTERN_1B.matcher(content);
            while (matcher.find()) {
                var ref = matcher.group(1);
                var resolvedNode = resolveReference(ref);
                if (resolvedNode == null) continue;
                if (resolvedNode.equals("import")) continue;

                var sourceNode = findParentNodeForFile(relPath);
                if (sourceNode != null && !sourceNode.equals(resolvedNode)) {
                    edges.add(new Edge(sourceNode, resolvedNode, "depends_on", Map.of(
                        "file", relPath,
                        "scan", "phase1b"
                    )));
                }
            }
        }
    }

    private String resolveReference(String ref) {
        if (nodes.containsKey(ref)) return ref;
        for (var prefix : List.of("def:", "thm:", "lem:", "prop:", "cor:", "axm:", "asm:",
                "proof:", "rem:", "ex:", "ki:", "cex:", "obs:",
                "hyp:", "mech:", "bio:", "drug:", "trt:", "sx:", "cit:",
                "causal:", "model:", "var:", "spec:", "prot:", "pat:",
                "fig:", "tab:", "sym:", "ch:", "sec:", "subsec:", "vol:", "part:")) {
            var candidate = prefix + ref;
            if (nodes.containsKey(candidate)) return candidate;
        }
        var defCand = "def:" + ref;
        if (nodes.containsKey(defCand)) return defCand;
        if (nodes.containsKey("heading:" + ref)) return "heading:" + ref;
        return null;
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
        for (var file : files) {
            var content = Files.readString(file);
            var relPath = projectRoot.relativize(file).toString();
            var fileNode = "file:" + pathToNode(relPath);
            var matcher = INCLUDE_PATTERN.matcher(content);

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

        addCrossVolumeEdges();
    }

    private void addCrossVolumeEdges() {
        var conceptToNodes = new LinkedHashMap<String, Set<String>>();
        for (var n : nodes.values()) {
            if (n.type().equals("def") && !n.file().isEmpty()) {
                conceptToNodes.computeIfAbsent(n.name(), k -> new LinkedHashSet<>()).add(n.id());
            }
        }

        for (var e : conceptToNodes.entrySet()) {
            var nodeIds = new ArrayList<>(e.getValue());
            if (nodeIds.size() < 2) continue;
            var topDirs = new LinkedHashSet<String>();
            for (var id : nodeIds) {
                var n = nodes.get(id);
                if (n == null) continue;
                var f = n.file();
                var top = f.contains("/") ? f.substring(0, f.indexOf('/')) : f;
                topDirs.add(top);
            }
            if (topDirs.size() < 2) continue;

            var first = nodeIds.getFirst();
            for (int i = 1; i < nodeIds.size(); i++) {
                var second = nodeIds.get(i);
                if (!first.equals(second)) {
                    edges.add(new Edge(first, second, "shares_concept", Map.of(
                        "concept", e.getKey()
                    )));
                }
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
        var knownPrefixes = Set.of("def:", "thm:", "lem:", "prop:", "cor:", "axm:", "asm:",
                "proof:", "rem:", "ex:", "ki:", "cex:", "obs:",
                "hyp:", "mech:", "bio:", "drug:", "trt:", "sx:", "cit:",
                "causal:", "model:", "var:", "spec:", "prot:", "pat:",
                "fig:", "tab:", "sym:", "ch:", "sec:", "subsec:", "vol:", "part:",
                "heading:");

        for (var file : files) {
            var content = Files.readString(file);
            var relPath = projectRoot.relativize(file).toString();
            var matcher = REF_PATTERN_2.matcher(content);

            while (matcher.find()) {
                var ref = matcher.group(1);
                String fullRef = null;

                if (nodes.containsKey(ref)) {
                    fullRef = ref;
                } else {
                    for (var prefix : knownPrefixes) {
                        var candidate = prefix + ref;
                        if (nodes.containsKey(candidate)) {
                            fullRef = candidate;
                            break;
                        }
                    }
                }

                if (fullRef == null && ref.contains(":")) {
                    var prefixCheck = ref.contains(":") ? ref.substring(0, ref.indexOf(':') + 1) : "";
                    if (knownPrefixes.contains(prefixCheck)) {
                        fullRef = ref;
                    }
                }

                if (fullRef == null) {
                    var defCand = "def:" + ref;
                    if (!nodes.containsKey(defCand)) {
                        var line = contentBeforeLine(content, matcher.start());
                        nodes.put(defCand, new Node(defCand, "def", ref, relPath, String.valueOf(line),
                            new LinkedHashMap<>(Map.of("line", String.valueOf(line), "file", relPath, "name", ref, "auto", "true"))));
                    }
                    fullRef = defCand;
                }

                var sourceNode = findParentNodeForFile(relPath);
                if (sourceNode != null && !sourceNode.equals(fullRef)) {
                    edges.add(new Edge(sourceNode, fullRef, "depends_on", Map.of(
                        "file", relPath,
                        "implicit", "false"
                    )));
                }
            }
        }

        addDefinesEdges();
    }

    private void addDefinesEdges() {
        var defFileMap = new LinkedHashMap<String, String>();
        for (var n : nodes.values()) {
            if (n.type().equals("def") && !isCitationKey(n.name()) && !n.file().isEmpty()) {
                defFileMap.putIfAbsent(n.name(), n.file());
            }
        }

        var citToDef = new LinkedHashMap<String, Set<String>>();
        for (var citNode : nodes.values()) {
            if (!citNode.type().equals("def") || !isCitationKey(citNode.name())) continue;
            var citFile = citNode.file();
            if (citFile.isEmpty()) continue;

            for (var e : defFileMap.entrySet()) {
                var defName = e.getKey();
                var defFile = e.getValue();
                var defNodeId = findNodeId(defName, defFile);
                if (defNodeId == null) continue;

                if (citFile.equals(defFile) || fileIncludes(citFile, defFile)) {
                    citToDef.computeIfAbsent(citNode.id(), k -> new LinkedHashSet<>()).add(defNodeId);
                }
            }
        }

        for (var e : citToDef.entrySet()) {
            for (var defId : e.getValue()) {
                edges.add(new Edge(e.getKey(), defId, "defines", Map.of()));
            }
        }
    }

    private boolean fileIncludes(String parentRelPath, String childRelPath) {
        var parentId = "file:" + pathToNode(parentRelPath);
        var childId = "file:" + pathToNode(childRelPath);
        return includesTransitively(parentId, childId, new HashSet<>());
    }

    private boolean includesTransitively(String from, String to, Set<String> visited) {
        if (from.equals(to)) return true;
        if (!visited.add(from)) return false;
        for (var dep : includeTree.getOrDefault(from, List.of())) {
            if (includesTransitively(dep, to, visited)) return true;
        }
        return false;
    }

    private String findNodeId(String name, String file) {
        for (var n : nodes.values()) {
            if (n.type().equals("def") && n.name().equals(name) && n.file().equals(file)) {
                return n.id();
            }
        }
        return null;
    }

    private List<String> findLabelsInFile(String relPath) {
        var result = new ArrayList<String>();
        for (var n : nodes.values()) {
            if (n.file().equals(relPath)) result.add(n.id());
        }
        return result;
    }

    private boolean isCitationKey(String name) {
        return name.length() > 10 && Character.isLowerCase(name.charAt(0))
            && name.matches("[a-z]+[0-9]{4}[a-zA-Z].*");
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

    private void phase7EntityResolution() {
        var canonicalNodes = new LinkedHashMap<String, Node>();
        var aliases = new LinkedHashMap<String, List<String>>();

        for (var n : nodes.values()) {
            if (isStructuralNode(n)) {
                canonicalNodes.put(n.id(), n);
                continue;
            }
            var key = n.type() + "::" + n.name();
            var existing = canonicalNodes.get(key);
            if (existing == null) {
                canonicalNodes.put(key, n);
                aliases.computeIfAbsent(n.id(), k -> new ArrayList<>()).add(n.id());
            } else {
                aliases.computeIfAbsent(existing.id(), k -> new ArrayList<>()).add(n.id());
            }
        }

        var mergedEdges = new LinkedHashSet<String>();
        for (var e : aliases.entrySet()) {
            var canonicalId = e.getKey();
            for (var aliasId : e.getValue()) {
                if (aliasId.equals(canonicalId)) continue;
                for (int i = 0; i < edges.size(); i++) {
                    var edge = edges.get(i);
                    var newSrc = edge.source().equals(aliasId) ? canonicalId : edge.source();
                    var newTgt = edge.target().equals(aliasId) ? canonicalId : edge.target();
                    if (!newSrc.equals(edge.source()) || !newTgt.equals(edge.target())) {
                        edges.set(i, new Edge(newSrc, newTgt, edge.type(), edge.properties()));
                    }
                }
            }
        }
        edges.removeIf(edge -> edge.source().equals(edge.target()));

        var deduped = new LinkedHashSet<String>();
        edges.removeIf(edge -> !deduped.add(edge.source() + "→" + edge.target() + "#" + edge.type()));

        var resolved = new LinkedHashMap<String, Node>();
        for (var e : canonicalNodes.entrySet()) {
            var node = e.getValue();
            var aliasList = aliases.getOrDefault(node.id(), List.of());
            if (aliasList.size() > 1) {
                var allFiles = aliasList.stream().map(id -> {
                    var n = nodes.get(id);
                    return n != null ? n.file() : "";
                }).filter(f -> !f.isEmpty()).distinct().sorted().toList();
                var mergedProps = new LinkedHashMap<>(node.properties());
                mergedProps.put("files", String.join(";; ", allFiles));
                resolved.put(node.id(), new Node(node.id(), node.type(), node.name(),
                    node.file(), node.line(), mergedProps));
            } else {
                resolved.put(node.id(), node);
            }
        }

        nodes.clear();
        nodes.putAll(resolved);
        System.err.println("[entity-resolution] canonicalized " + canonicalNodes.size()
            + " nodes from " + resolved.size() + " (aliases resolved)");
    }

    private boolean isStructuralNode(Node n) {
        return n.type().equals("file") || n.type().equals("project")
            || n.type().equals("volume") || n.type().equals("chapter")
            || n.type().equals("section") || n.type().equals("subsection");
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
                    if (entry != null && entry.key().equals("name"))
                        project = entry.value();
                }
                case "label_rules", "edge_rules" -> {
                    if (trimmed.startsWith("-")) {
                        flushCurrent(labelRules, edgeRules, section, currentMap);
                        currentMap.clear();
                        var rest = trimmed.substring(1).strip();
                        var entry = parseKeyValue(rest);
                        if (entry != null) currentMap.put(entry.key(), entry.value());
                    } else {
                        var entry = parseKeyValue(trimmed);
                        if (entry != null) currentMap.put(entry.key(), entry.value());
                    }
                }
                case "naming_conventions" -> {
                    var match = NAMING_CONV_PATTERN.matcher(trimmed);
                    if (match.find()) {
                        var rel = match.group(1);
                        var types = match.group(2).replace("\"", "").split(",\\s*");
                        namingConventions.put(rel, List.of(types));
                    }
                }
                case "structural_prefixes" -> {
                    var match = STRUCTURAL_PREFIX_PATTERN.matcher(trimmed);
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

    private static KeyValue parseKeyValue(String line) {
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

        return new KeyValue(key, value);
    }

    private record KeyValue(String key, String value) {}

    static KeyValue toKeyValue(Map<String, String> map, String key) {
        var value = map.get(key);
        return value != null ? new KeyValue(key, value) : null;
    }
}
