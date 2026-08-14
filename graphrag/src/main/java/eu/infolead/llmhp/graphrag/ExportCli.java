package eu.infolead.llmhp.graphrag;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;
import java.util.stream.*;
import eu.infolead.llmhp.graph.GraphQueryEngine;
import eu.infolead.llmhp.graph.types.Graph;
import eu.infolead.llmhp.graphrag.DocumentWriter.ExportedDocument;
import eu.infolead.llmhp.graphrag.LatexExporter.LatexChunk;
import eu.infolead.llmhp.graphrag.types.ExportConfig;
import eu.infolead.llmhp.graphrag.types.SemanticBlock;

public final class ExportCli {

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("""
                ExportCli <cmd> [args...]
                Commands:
                  export <project-root> <config-yaml> <out-dir> [--files a.typ,b.tex]
                  list-duplicates <project-root> <config-yaml>
                """);
            System.exit(2);
        }
        var cmd = args[0];
        switch (cmd) {
            case "export" -> {
                var projectRoot = Path.of(args[1]);
                var config = ExportConfig.parse(Files.readString(Path.of(args[2])), null, projectRoot);
                var outDir = Path.of(args[3]);
                List<String> onlyFiles = null;
                for (int i = 4; i < args.length; i++) {
                    if (args[i].equals("--files") && i + 1 < args.length) {
                        onlyFiles = Arrays.asList(args[i + 1].split(","));
                        i++;
                    }
                }
                var stats = export(config, outDir, onlyFiles);
                System.out.println("exported=" + stats.exported()
                    + " typst=" + stats.typstDocs()
                    + " latex=" + stats.latexDocs()
                    + " dedup-skipped=" + stats.dedupSkipped()
                    + " blocks=" + stats.totalBlocks());
            }
            case "list-duplicates" -> {
                var projectRoot = Path.of(args[1]);
                var config = ExportConfig.parse(Files.readString(Path.of(args[2])), null, projectRoot);
                var typstLabels = collectTypstLabels(config);
                var latex = new LatexExporter("pandoc");
                var dupes = findDuplicates(config, typstLabels, latex);
                for (var d : dupes) System.out.println(d);
                System.out.println("duplicates=" + dupes.size());
            }
            default -> {
                System.err.println("Unknown command: " + cmd);
                System.exit(2);
            }
        }
    }

    public record ExportStats(int exported, int typstDocs, int latexDocs,
                              int dedupSkipped, int totalBlocks) {}

    public static ExportStats export(ExportConfig config, Path outDir, List<String> onlyFiles)
            throws IOException {
        var inputDir = outDir.resolve("input");
        Files.createDirectories(inputDir);

        var typstLabels = collectTypstLabels(config);
        var splitter = new TypstBlockSplitter();
        var latex = new LatexExporter("pandoc");

        var structureContext = buildStructureIndex(config);

        int exported = 0, typstDocs = 0, latexDocs = 0, dedupSkipped = 0, totalBlocks = 0;

        for (var file : findFiles(config, ".typ", onlyFiles)) {
            var relPath = config.projectRoot().relativize(file).toString();
            var content = Files.readString(file);
            var result = splitter.split(content, relPath);
            totalBlocks += result.blocks().size();
            var doc = docName(relPath);
            var ctx = structureContext.getOrDefault(relPath, pathDerivedStructure(relPath));
            for (var block : result.blocks()) {
                if (block.body().isBlank()) continue;
                block = linkProof(block, file, typstLabels);
                var provisional = new ExportedDocument("", doc, "typst", "primary", block);
                var d = new ExportedDocument(DocumentWriter.docId(provisional),
                    doc, "typst", "primary", block);
                DocumentWriter.write(inputDir, d, ctx);
                exported++;
            }
            typstDocs++;
        }

        for (var file : findFiles(config, ".tex", onlyFiles)) {
            var relPath = config.projectRoot().relativize(file).toString();
            var content = Files.readString(file);
            var chunks = latex.split(content, relPath);
            totalBlocks += chunks.size();
            var doc = docName(relPath);
            var ctx = structureContext.getOrDefault(relPath, pathDerivedStructure(relPath));
            for (var chunk : chunks) {
                if (chunk.label() != null && typstLabels.contains(chunk.label())) {
                    dedupSkipped++;
                    continue;
                }
                if (chunk.latexBody().isBlank()) continue;
                var md = latex.toMarkdown(chunk.latexBody());
                var block = latex.toBlock(chunk, md);
                var provisional = new ExportedDocument("", doc, "latex", "legacy", block);
                var d = new ExportedDocument(DocumentWriter.docId(provisional),
                    doc, "latex", "legacy", block);
                DocumentWriter.write(inputDir, d, ctx);
                exported++;
            }
            latexDocs++;
        }

        return new ExportStats(exported, typstDocs, latexDocs, dedupSkipped, totalBlocks);
    }

    public static Set<String> collectTypstLabels(ExportConfig config) throws IOException {
        var labels = new LinkedHashSet<String>();
        var pattern = java.util.regex.Pattern.compile("<([a-zA-Z][a-zA-Z0-9_:-]+)>");
        for (var file : findFiles(config, ".typ", null)) {
            var content = Files.readString(file);
            var m = pattern.matcher(content);
            while (m.find()) labels.add(m.group(1));
        }
        return labels;
    }

    public static List<String> findDuplicates(ExportConfig config, Set<String> typstLabels,
                                              LatexExporter latex) throws IOException {
        var dupes = new ArrayList<String>();
        for (var file : findFiles(config, ".tex", null)) {
            var relPath = config.projectRoot().relativize(file).toString();
            var chunks = latex.split(Files.readString(file), relPath);
            for (var chunk : chunks) {
                if (chunk.label() != null && typstLabels.contains(chunk.label())) {
                    dupes.add(relPath + ":" + chunk.line() + " " + chunk.label());
                }
            }
        }
        return dupes;
    }

    static final Map<String, String> FILE_PREFIX_TO_LABEL = Map.of(
        "thm", "thm", "prop", "prop", "cor", "cor", "lem", "lem", "conj", "conj");

    static SemanticBlock linkProof(SemanticBlock block, Path file, Set<String> typstLabels) {
        if (block.kind() != SemanticBlock.Kind.PROOF
                && block.kind() != SemanticBlock.Kind.SOLUTION) return block;
        if (!block.refs().isEmpty()) return block;
        var proves = inferProvesLabel(file, typstLabels);
        if (proves == null) return block;
        return new SemanticBlock(block.kind(), block.label(), block.name(), block.body(),
            block.file(), block.line(), List.of(proves));
    }

    static String inferProvesLabel(Path file, Set<String> typstLabels) {
        var name = file.getFileName().toString().replaceFirst("\\.typ$", "");
        if (!name.endsWith("-proof")) return null;
        var base = name.substring(0, name.length() - "-proof".length());
        int dash = base.indexOf('-');
        if (dash < 0) return null;
        var prefix = FILE_PREFIX_TO_LABEL.get(base.substring(0, dash));
        if (prefix == null) return null;
        var candidate = prefix + ":" + base.substring(dash + 1);
        return typstLabels.contains(candidate) ? candidate : null;
    }

    static Map<String, List<String>> buildStructureIndex(ExportConfig config) {
        var index = new HashMap<String, List<String>>();
        var graphFile = config.projectRoot().resolve("graph.json");
        if (Files.exists(graphFile)) {
            try {
                Graph graph = GraphQueryEngine.load(graphFile);
                for (var edge : graph.edges()) {
                    if (!edge.type().equals("appears_in")) continue;
                    if (!edge.source().startsWith("file:")) continue;
                    var tgt = edge.target();
                    if (!(tgt.startsWith("vol:") || tgt.startsWith("ch:") || tgt.startsWith("sec:")
                            || tgt.startsWith("subsec:") || tgt.startsWith("part:"))) continue;
                    var node = graph.nodes().get(edge.source());
                    if (node == null || node.name().isEmpty()) continue;
                    var ctx = index.computeIfAbsent(node.name(), k -> new ArrayList<>());
                    if (!ctx.contains(tgt)) ctx.add(tgt);
                }
                if (!index.isEmpty()) return index;
            } catch (Exception e) {
                System.err.println("[export] graph.json load failed ("
                    + e.getMessage() + ") — using path-derived structure");
            }
        }
        return index;
    }

    static List<String> pathDerivedStructure(String relPath) {
        var ctx = new ArrayList<String>();
        for (var seg : relPath.split("/")) {
            if (seg.startsWith("volume-")) ctx.add("vol:" + seg);
            else if (seg.startsWith("part")) ctx.add("part:" + seg);
            else if (seg.startsWith("ch")) ctx.add("ch:" + seg);
            else if (seg.startsWith("sec") || seg.startsWith("subsec")) ctx.add("sec:" + seg);
        }
        return ctx;
    }

    static String docName(String relPath) {
        var parts = relPath.split("/");
        for (var p : parts) {
            if (p.startsWith("volume-")) return p;
        }
        if (parts.length > 0) {
            return switch (parts[0]) {
                case "src" -> parts.length > 2 ? parts[2] : parts[0];
                default -> parts[0];
            };
        }
        return "corpus";
    }

    static List<Path> findFiles(ExportConfig config, String ext, List<String> onlyFiles)
            throws IOException {
        var root = config.projectRoot();
        var latexRoot = root.resolve(config.latexRoot());
        var result = new ArrayList<Path>();

        if (onlyFiles != null) {
            for (var f : onlyFiles) {
                var p = f.strip();
                if (!p.endsWith(ext)) continue;
                var resolved = p.startsWith("/") ? Path.of(p) : root.resolve(p);
                if (Files.exists(resolved)) result.add(resolved);
            }
            return result;
        }

        var exclude = config.excludeDirs();
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(root) && isExcluded(root.relativize(dir).toString(), exclude)) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path f, BasicFileAttributes attrs) {
                if (!f.toString().endsWith(ext)) return FileVisitResult.CONTINUE;
                if (isExcluded(root.relativize(f).toString(), exclude)) return FileVisitResult.CONTINUE;
                if (ext.equals(".tex") != f.startsWith(latexRoot)) return FileVisitResult.CONTINUE;
                result.add(f);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path f, IOException exc) {
                // Tolerate a path that vanished mid-walk (transient .git/submodule
                // churn). Any other failure (unreadable root, permission denied)
                // is a real error and must propagate, not be silently swallowed.
                if (exc instanceof NoSuchFileException) return FileVisitResult.CONTINUE;
                throw new UncheckedIOException(exc);
            }
        });
        result.sort(null);
        return result;
    }

    static boolean isExcluded(String relPath, List<String> excludeDirs) {
        for (var part : relPath.split("/")) {
            if (excludeDirs.contains(part)) return true;
        }
        return false;
    }
}
