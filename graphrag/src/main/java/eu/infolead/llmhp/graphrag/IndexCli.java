package eu.infolead.llmhp.graphrag;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.regex.*;
import eu.infolead.llmhp.graphrag.types.ExportConfig;
import eu.infolead.llmhp.graphrag.types.Manifest;

public final class IndexCli {

    private static final long STALE_LOCK_SECONDS = 6 * 3600;

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("""
                IndexCli <cmd> [args...]
                Commands:
                  init <project-root> <config-yaml> [plugin-dir]
                  init-sample <project-root> <config-yaml> <sample-root> [plugin-dir]
                  update <project-root> <config-yaml>
                  status <project-root> <config-yaml>
                """);
            System.exit(2);
        }
        var cmd = args[0];
        var projectRoot = Path.of(args[1]);
        var config = ExportConfig.parse(Files.readString(Path.of(args[2])), null, projectRoot);
        var indexRoot = projectRoot.resolve(config.indexRoot());

        switch (cmd) {
            case "init" -> {
                var pluginDir = args.length > 3 ? Path.of(args[3]) : null;
                if (!acquireLock(indexRoot)) {
                    System.err.println("LOCKED: another index job is running");
                    System.exit(3);
                }
                try {
                    init(config, indexRoot, pluginDir);
                } finally {
                    releaseLock(indexRoot);
                }
            }
            case "init-sample" -> {
                var sampleRoot = Path.of(args[3]);
                var pluginDir = args.length > 4 ? Path.of(args[4]) : null;
                Files.createDirectories(sampleRoot);
                writeSettings(config, sampleRoot);
                if (pluginDir != null) copyPrompts(pluginDir.resolve("prompts"), sampleRoot.resolve("prompts"));
                System.out.println("[init-sample] settings.yaml + prompts written to " + sampleRoot);
            }
            case "update" -> {
                if (!acquireLock(indexRoot)) {
                    System.err.println("LOCKED: another index job is running");
                    System.exit(3);
                }
                try {
                    update(config, indexRoot);
                } finally {
                    releaseLock(indexRoot);
                }
            }
            case "status" -> status(config, indexRoot);
            default -> {
                System.err.println("Unknown command: " + cmd);
                System.exit(2);
            }
        }
    }

    static void init(ExportConfig config, Path indexRoot, Path pluginDir) throws Exception {
        Files.createDirectories(indexRoot);
        System.out.println("[init] exporting corpus...");
        var stats = ExportCli.export(config, indexRoot, null);
        System.out.println("[init] exported=" + stats.exported()
            + " dedup-skipped=" + stats.dedupSkipped());

        writeSettings(config, indexRoot);
        if (pluginDir != null) copyPrompts(pluginDir.resolve("prompts"), indexRoot.resolve("prompts"));

        System.out.println("[init] running graphrag index...");
        int exit = runGraphrag(config, indexRoot, "index");
        if (exit != 0) {
            System.err.println("[init] graphrag index failed with exit code " + exit);
            System.exit(exit);
        }

        writeManifest(config, indexRoot, List.of());
        System.out.println("[init] done");
    }

    static void update(ExportConfig config, Path indexRoot) throws Exception {
        var manifestFile = indexRoot.resolve("manifest.json");
        boolean firstRun = !Files.exists(manifestFile);

        var dirty = new ArrayList<String>();
        if (!firstRun) {
            dirty.addAll(Manifest.fromJson(Files.readString(manifestFile)).dirty());
        }

        if (firstRun) {
            Files.createDirectories(indexRoot);
            writeSettings(config, indexRoot);
            var pluginDir = indexRoot.getParent().resolve("graphrag/prompts");
            if (!Files.isDirectory(pluginDir)) {
                var harnessGraphrag = Path.of("graphrag/prompts");
                if (Files.isDirectory(harnessGraphrag)) pluginDir = harnessGraphrag;
            }
            if (Files.isDirectory(pluginDir)) copyPrompts(pluginDir, indexRoot.resolve("prompts"));
            var manifest = Manifest.fromJson(Files.readString(manifestFile));
            dirty.addAll(manifest.dirty());
            writeManifest(config, indexRoot, List.of());
            System.out.println("[update] first run — init'ed index scaffolding, dirty files to index: " + dirty.size());
        }

        if (dirty.isEmpty()) {
            System.out.println("[update] dirty-set empty, nothing to do");
            return;
        }

        var inputDir = indexRoot.resolve("input");
        int removed = removeDocsForSources(inputDir, dirty);

        int exported = 0;
        try {
            var stats = ExportCli.export(config, indexRoot, dirty);
            exported = stats.exported();
        } catch (Exception e) {
            e.printStackTrace();
        }

        // GraphRAG `update` cannot bootstrap: it needs an existing
        // output/documents.parquet to diff against. Cold start (no output dir,
        // or no manifest) must run `index` once on whatever documents are present,
        // even if that is a single dirty file. After that, `update` works.
        boolean hasIndex = Files.isDirectory(indexRoot.resolve("output"))
            && Files.exists(indexRoot.resolve("output").resolve("documents.parquet"));
        String subcommand = (firstRun || !hasIndex) ? "index" : "update";
        int exit = runGraphrag(config, indexRoot, subcommand);
        if (exit != 0) {
            System.err.println("[update] graphrag " + subcommand + " failed with exit code " + exit);
            System.exit(exit);
        }

        if (!firstRun) promote(indexRoot);
        writeManifest(config, indexRoot, List.of());
        System.out.println("[update] done — " + exported + " blocks indexed");
    }

    static void status(ExportConfig config, Path indexRoot) throws IOException {
        var manifestFile = indexRoot.resolve("manifest.json");
        if (!Files.exists(manifestFile)) {
            System.out.println("index: missing");
            return;
        }
        var manifest = Manifest.fromJson(Files.readString(manifestFile));
        var currentVersion = graphragVersion(config.graphragBinary());
        boolean match = currentVersion != null && currentVersion.equals(manifest.graphragVersion());

        System.out.println("index: present");
        System.out.println("commit: " + manifest.commit());
        System.out.println("timestamp: " + manifest.timestamp());
        System.out.println("dirty: " + manifest.dirty().size());
        for (var d : manifest.dirty()) System.out.println("  " + d);
        System.out.println("graphrag_version_indexed: " + manifest.graphragVersion());
        System.out.println("graphrag_version_current: " + (currentVersion != null ? currentVersion : "binary not found"));
        System.out.println("graphrag_binary: " + manifest.graphragBinary());
        System.out.println("version_match: " + (match ? "yes" : "NO — reindex required"));
    }

    static int runGraphrag(ExportConfig config, Path indexRoot, String subcommand)
            throws IOException, InterruptedException {
        var cmd = new ArrayList<String>();
        cmd.add(config.graphragBinary());
        cmd.add(subcommand);
        cmd.add("--root");
        cmd.add(indexRoot.toString());
        cmd.add("--config");
        cmd.add(indexRoot.resolve("settings.yaml").toString());
        var proc = new ProcessBuilder(cmd)
            .directory(indexRoot.toFile())
            .inheritIO()
            .start();
        return proc.waitFor();
    }

    static void promote(Path indexRoot) throws IOException {
        var output = indexRoot.resolve("output");
        var updateOutput = indexRoot.resolve("update_output");
        if (!Files.isDirectory(updateOutput)) {
            System.err.println("[promote] update_output missing — skipping promotion");
            return;
        }
        if (Files.exists(output)) deleteRecursive(output);
        Files.move(updateOutput, output);
    }

    static int removeDocsForSources(Path inputDir, List<String> dirtySources) throws IOException {
        if (!Files.isDirectory(inputDir)) return 0;
        var dirtySet = new HashSet<String>();
        for (var d : dirtySources) {
            dirtySet.add(d);
            dirtySet.add(Path.of(d).getFileName().toString());
        }
        int removed = 0;
        try (var stream = Files.list(inputDir)) {
            for (var f : stream.toList()) {
                if (!f.toString().endsWith(".md")) continue;
                var head = Files.readString(f);
                var m = Pattern.compile("^file:\\s*(.+)$", Pattern.MULTILINE).matcher(head);
                if (m.find()) {
                    var source = m.group(1).strip();
                    if (dirtySet.contains(source)) {
                        Files.deleteIfExists(f);
                        removed++;
                    }
                }
            }
        }
        return removed;
    }

    static void writeManifest(ExportConfig config, Path indexRoot, List<String> dirty)
            throws IOException {
        var commit = gitCommit(config.projectRoot());
        var version = graphragVersion(config.graphragBinary());
        var binary = resolveBinary(config.graphragBinary());
        var manifest = new Manifest(
            commit != null ? commit : "",
            Instant.now().toString(),
            version != null ? version : "",
            binary != null ? binary : config.graphragBinary(),
            List.copyOf(dirty)
        );
        Files.createDirectories(indexRoot);
        var tmp = indexRoot.resolve("manifest.json.tmp");
        Files.writeString(tmp, manifest.toJson());
        Files.move(tmp, indexRoot.resolve("manifest.json"),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            java.nio.file.StandardCopyOption.ATOMIC_MOVE);
    }

    static String gitCommit(Path projectRoot) {
        try {
            var proc = new ProcessBuilder("git", "rev-parse", "HEAD")
                .directory(projectRoot.toFile())
                .redirectErrorStream(true)
                .start();
            var out = new String(proc.getInputStream().readAllBytes()).strip();
            return proc.waitFor() == 0 ? out : null;
        } catch (IOException | InterruptedException e) {
            return null;
        }
    }

    static String graphragVersion(String binary) {
        try {
            var proc = new ProcessBuilder("python3", "-c",
                "from importlib.metadata import version; print(version('graphrag'))")
                .redirectErrorStream(true)
                .start();
            var out = new String(proc.getInputStream().readAllBytes()).strip();
            if (proc.waitFor() == 0 && out.matches("\\d+\\.\\d+\\.\\d+.*")) return out;
        } catch (IOException | InterruptedException ignored) {}
        var resolved = resolveBinary(binary);
        if (resolved != null) {
            var m = Pattern.compile("graphrag-(\\d+\\.\\d+\\.\\d+)").matcher(resolved);
            if (m.find()) return m.group(1);
        }
        return null;
    }

    static String resolveBinary(String binary) {
        var pathEnv = System.getenv("PATH");
        if (pathEnv == null) return null;
        for (var dir : pathEnv.split(":")) {
            var candidate = Path.of(dir, binary);
            if (Files.isExecutable(candidate)) return candidate.toString();
        }
        return null;
    }

    static void writeSettings(ExportConfig config, Path indexRoot) throws IOException {
        var models = config.models();
        String chatProvider;
        String chatModel;
        int slash = models.chatModel().indexOf('/');
        if (slash > 0) {
            chatProvider = models.chatModel().substring(0, slash);
            chatModel = models.chatModel().substring(slash + 1);
        } else {
            chatProvider = "openai";
            chatModel = models.chatModel();
        }
        var chatApiBase = models.chatApiBase();
        if (chatApiBase == null || chatApiBase.isBlank()) {
            if (chatProvider.equals("deepseek")) {
                chatApiBase = "https://api.deepseek.com/v1";
            }
        }
        if (chatProvider.equals("deepseek")) {
            chatProvider = "openai";
        }
        var sb = new StringBuilder();
        sb.append("models:\n");
        sb.append("  default_chat_model:\n");
        sb.append("    type: chat\n");
        sb.append("    model_provider: ").append(chatProvider).append("\n");
        sb.append("    auth_type: api_key\n");
        if (!chatApiBase.isBlank()) {
            sb.append("    api_base: ").append(chatApiBase).append("\n");
        }
        sb.append("    api_key: ${").append(models.chatApiKeyEnv()).append("}\n");
        sb.append("    model: ").append(chatModel).append("\n");
        sb.append("    model_supports_json: true\n");
        sb.append("    concurrent_requests: 10\n");
        sb.append("    async_mode: asyncio\n");
        sb.append("    retry_strategy: native\n");
        sb.append("    max_retries: 5\n");
        sb.append("  default_embedding_model:\n");
        sb.append("    type: embedding\n");
        sb.append("    model_provider: ").append(models.embeddingProvider()).append("\n");
        sb.append("    auth_type: api_key\n");
        sb.append("    api_key: ${").append(models.embeddingApiKeyEnv()).append("}\n");
        sb.append("    model: ").append(models.embeddingModel()).append("\n");
        sb.append("    api_base: ").append(models.embeddingApiBase()).append("\n");
        sb.append("    concurrent_requests: 10\n");
        sb.append("    async_mode: asyncio\n");
        sb.append("    retry_strategy: native\n");
        sb.append("    max_retries: 5\n");
        sb.append("\n");
        sb.append("input:\n");
        sb.append("  storage:\n");
        sb.append("    type: file\n");
        sb.append("    base_dir: input\n");
        sb.append("  file_type: text\n");
        sb.append("  file_pattern: \".*\\\\.md$$\"\n");
        sb.append("\n");
        sb.append("chunks:\n");
        sb.append("  size: 16000\n");
        sb.append("  overlap: 100\n");
        sb.append("  group_by_columns: [id]\n");
        sb.append("\n");
        sb.append("output:\n");
        sb.append("  type: file\n");
        sb.append("  base_dir: output\n");
        sb.append("\n");
        sb.append("update_index_output:\n");
        sb.append("  type: file\n");
        sb.append("  base_dir: update_output\n");
        sb.append("\n");
        sb.append("cache:\n");
        sb.append("  type: file\n");
        sb.append("  base_dir: cache\n");
        sb.append("\n");
        sb.append("reporting:\n");
        sb.append("  type: file\n");
        sb.append("  base_dir: logs\n");
        sb.append("\n");
        sb.append("vector_store:\n");
        sb.append("  default_vector_store:\n");
        sb.append("    type: lancedb\n");
        sb.append("    db_uri: lancedb\n");
        sb.append("    container_name: default\n");
        sb.append("\n");
        sb.append("embed_text:\n");
        sb.append("  model_id: default_embedding_model\n");
        sb.append("  vector_store_id: default_vector_store\n");
        sb.append("\n");
        sb.append("extract_graph:\n");
        sb.append("  model_id: default_chat_model\n");
        sb.append("  prompt: prompts/extract_graph.txt\n");
        sb.append("  entity_types: [theorem, definition, lemma, axiom, principle, concept, notation, paper, author, pattern, verdict]\n");
        sb.append("  max_gleanings: 1\n");
        sb.append("\n");
        sb.append("summarize_descriptions:\n");
        sb.append("  model_id: default_chat_model\n");
        sb.append("  prompt: prompts/summarize_descriptions.txt\n");
        sb.append("  max_length: 500\n");
        sb.append("\n");
        sb.append("cluster_graph:\n");
        sb.append("  max_cluster_size: 10\n");
        sb.append("\n");
        sb.append("extract_claims:\n");
        sb.append("  enabled: true\n");
        sb.append("  model_id: default_chat_model\n");
        sb.append("  prompt: prompts/extract_claims.txt\n");
        sb.append("  description: \"Rule-violation claims in software-architecture text: driver-ranking language (primary/dominant/main/secondary driver), 'subsume' usage, IVP rule violations, fabricated artifacts.\"\n");
        sb.append("  max_gleanings: 1\n");
        sb.append("\n");
        sb.append("community_reports:\n");
        sb.append("  model_id: default_chat_model\n");
        sb.append("  graph_prompt: prompts/community_report_graph.txt\n");
        sb.append("  text_prompt: prompts/community_report_text.txt\n");
        sb.append("  max_length: 2000\n");
        sb.append("  max_input_length: 8000\n");
        Files.writeString(indexRoot.resolve("settings.yaml"), sb.toString());
    }

    static void copyPrompts(Path source, Path target) throws IOException {
        if (!Files.isDirectory(source)) return;
        Files.createDirectories(target);
        try (var stream = Files.list(source)) {
            for (var f : stream.toList()) {
                if (f.toString().endsWith(".txt")) {
                    Files.copy(f, target.resolve(f.getFileName()),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    static boolean acquireLock(Path indexRoot) throws IOException {
        Files.createDirectories(indexRoot);
        var lock = indexRoot.resolve(".lock");
        if (Files.exists(lock)) {
            var content = Files.readString(lock).strip().split("\n");
            if (content.length >= 2) {
                try {
                    var ts = Instant.parse(content[1]);
                    if (Instant.now().getEpochSecond() - ts.getEpochSecond() < STALE_LOCK_SECONDS) {
                        return false;
                    }
                } catch (Exception ignored) {}
            }
        }
        try {
            var out = Files.newOutputStream(lock,
                java.nio.file.StandardOpenOption.CREATE_NEW,
                java.nio.file.StandardOpenOption.WRITE);
            out.write((ProcessHandle.current().pid() + "\n" + Instant.now() + "\n").getBytes());
            out.close();
            return true;
        } catch (FileAlreadyExistsException e) {
            return false;
        }
    }

    static void releaseLock(Path indexRoot) {
        try {
            Files.deleteIfExists(indexRoot.resolve(".lock"));
        } catch (IOException ignored) {}
    }

    static void deleteRecursive(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder())
                .map(Path::toFile)
                .forEach(File::delete);
        }
    }
}
