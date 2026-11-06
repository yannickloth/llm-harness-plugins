package eu.infolead.llmhp.graphrag;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.*;
import java.util.regex.*;
import eu.infolead.llmhp.graphrag.types.ExportConfig;
import eu.infolead.llmhp.graphrag.types.Manifest;

public final class IndexCli {

    private static final long STALE_LOCK_SECONDS = 6 * 3600;

    /** An artifact written this close to the run start still counts as this run's output. */
    private static final long GATE_MTIME_SLACK_MS = 5_000;

    /** Artifacts a run must produce before the index counts as complete. */
    private static final List<String> REQUIRED_ARTIFACTS = List.of(
        "documents.parquet",
        "text_units.parquet",
        "entities.parquet",
        "relationships.parquet",
        "communities.parquet",
        "community_reports.parquet");

    /** Extra artifact required when the settings enable claim extraction. */
    private static final String CLAIMS_ARTIFACT = "covariates.parquet";
    /** Vector store directory, required directly under the index root for every mode. */
    private static final String VECTOR_STORE_DIR = "lancedb";

    private static final String MANIFEST_FILE = "manifest.json";
    private static final String SETTINGS_FILE = "settings.yaml";
    private static final String OUTPUT_DIR = "output";
    private static final String UPDATE_OUTPUT_DIR = "update_output";

    private static final String STATUS_IDLE = "idle";
    private static final String STATUS_BUILDING = "building";
    private static final String STATUS_COMPLETE = "complete";
    private static final String STATUS_PARTIAL = "partial";
    private static final String STATUS_FAILED_RUN = "failed_run";

    private static final String SUBCOMMAND_INDEX = "index";
    private static final String SUBCOMMAND_UPDATE = "update";

    /** Commit value used when no manifest exists yet: there is no indexed commit to name. */
    private static final String NO_COMMIT = "none";
    private static final String CLAIMS_SETTINGS_KEY = "extract_claims:";
    private static final String CLAIMS_ENABLED_LINE = "enabled: true";

    /**
     * The manifest fields the completion gate owns. Grouped so the writer carries the
     * whole gate verdict as one value and no call site can transpose two reason strings.
     */
    record LifecycleState(
        String status,
        String lastGoodBuild,
        String partialReason,
        String failureReason,
        int consecutiveFailures,
        List<String> artifactsPresent
    ) {
        /** Gate passed: the index is complete, so the dirty set is cleared and the streak resets. */
        static LifecycleState complete(List<String> artifactsPresent) {
            return new LifecycleState(STATUS_COMPLETE, Instant.now().toString(),
                null, null, 0, artifactsPresent);
        }

        /** Gate failed: name the missing artifacts, keep the failure streak counting up. */
        static LifecycleState partial(List<String> missing, int consecutiveFailures,
                                      String lastGoodBuild, List<String> artifactsPresent) {
            return new LifecycleState(STATUS_PARTIAL, lastGoodBuild,
                "missing: " + String.join(", ", missing), null,
                consecutiveFailures, artifactsPresent);
        }

        /** The process exited non-zero: record why, keep the dirty set for the next attempt. */
        static LifecycleState failedRun(String reason, int consecutiveFailures,
                                       String lastGoodBuild, List<String> artifactsPresent) {
            return new LifecycleState(STATUS_FAILED_RUN, lastGoodBuild, null, reason,
                consecutiveFailures, artifactsPresent);
        }

        /** Nothing recorded yet beyond the write in progress. */
        static LifecycleState building(Optional<Manifest> previous) {
            return previous
                .map(m -> new LifecycleState(STATUS_BUILDING, m.lastGoodBuild(), m.partialReason(),
                    m.failureReason(), m.consecutiveFailures(), m.artifactsPresent()))
                .orElseGet(() -> new LifecycleState(STATUS_BUILDING, null, null, null, 0, List.of()));
        }
    }

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
        var previous = readManifestTolerant(indexRoot.resolve(MANIFEST_FILE));
        markBuilding(config, indexRoot, previous);

        Files.createDirectories(indexRoot);
        System.out.println("[init] exporting corpus...");
        var stats = ExportCli.export(config, indexRoot, null);
        System.out.println("[init] exported=" + stats.exported()
            + " dedup-skipped=" + stats.dedupSkipped());

        writeSettings(config, indexRoot);
        if (pluginDir != null) copyPrompts(pluginDir.resolve("prompts"), indexRoot.resolve("prompts"));

        System.out.println("[init] running graphrag index...");
        long runStartMs = System.currentTimeMillis();
        int exit = runGraphrag(config, indexRoot, SUBCOMMAND_INDEX);

        // Claims extraction is on unless the freshly written settings say otherwise,
        // so the expected artifact set is read from the settings of this run.
        boolean claims = claimsEnabled(indexRoot);
        var outputDir = indexRoot.resolve(OUTPUT_DIR);

        if (exit != 0) {
            writeManifest(config, indexRoot, unionDirty(indexRoot, preservedDirty(previous)),
                unionRemoved(indexRoot, preservedRemoved(previous)), fullReindexOf(previous),
                LifecycleState.failedRun(
                    "graphrag " + SUBCOMMAND_INDEX + " exit " + exit, failuresAfter(previous),
                    lastGoodBuild(previous), presentArtifacts(indexRoot, outputDir, runStartMs, claims)));
            throw new IOException("[init] graphrag index failed with exit code " + exit);
        }

        var missing = missingArtifacts(indexRoot, outputDir, runStartMs, claims);
        if (!missing.isEmpty()) {
            writeManifest(config, indexRoot, unionDirty(indexRoot, preservedDirty(previous)),
                unionRemoved(indexRoot, preservedRemoved(previous)), fullReindexOf(previous),
                LifecycleState.partial(
                    missing, failuresAfter(previous), lastGoodBuild(previous),
                    presentArtifacts(indexRoot, outputDir, runStartMs, claims)));
            reportIncomplete("init", missing);
            return;
        }

        writeManifest(config, indexRoot, dirtyRecordedDuringRun(indexRoot, preservedDirty(previous)),
            List.of(), false,
            LifecycleState.complete(presentArtifacts(indexRoot, outputDir, runStartMs, claims)));
        System.out.println("[init] done");
    }

    static void update(ExportConfig config, Path indexRoot) throws Exception {
        var manifestFile = indexRoot.resolve(MANIFEST_FILE);
        // FS-8: read the lifecycle record before the build marker is written. A first
        // run is detected from the file that exists now, so the old read inside the
        // `firstRun` branch — which could only ever hit NoSuchFileException — is gone.
        var previous = readManifestTolerant(manifestFile);
        boolean firstRun = previous.isEmpty();
        markBuilding(config, indexRoot, previous);

        var dirty = new ArrayList<>(preservedDirty(previous));

        if (firstRun) {
            Files.createDirectories(indexRoot);
            writeSettings(config, indexRoot);
            var pluginDir = indexRoot.getParent().resolve("graphrag/prompts");
            if (!Files.isDirectory(pluginDir)) {
                var harnessGraphrag = Path.of("graphrag/prompts");
                if (Files.isDirectory(harnessGraphrag)) pluginDir = harnessGraphrag;
            }
            if (Files.isDirectory(pluginDir)) copyPrompts(pluginDir, indexRoot.resolve("prompts"));
            System.out.println("[update] first run — init'ed index scaffolding, dirty files to index: "
                + dirty.size());
        }

        var outputDir = indexRoot.resolve(OUTPUT_DIR);
        boolean hasIndex = Files.isDirectory(outputDir)
            && Files.exists(outputDir.resolve("documents.parquet"));

        // FS-3: a dirty set above the configured threshold, or an index the last runs
        // left broken, rebuilds the whole corpus instead of scoping the work to `dirty`.
        // A "building" status counts as broken: this code runs under the index lock, so
        // a build marker that still stands belongs to a run that died, not to a live one.
        // A deletion or a structural input change (a .bib, a figure) also forces the full
        // path: graphrag `update` cannot be trusted to drop the entities of a document
        // that no longer exists, and a changed macro changes blocks no .tex names.
        boolean broken = previous
            .map(m -> STATUS_PARTIAL.equals(m.status()) || STATUS_FAILED_RUN.equals(m.status())
                || STATUS_BUILDING.equals(m.status()))
            .orElse(false);
        boolean fullRun = dirty.size() > config.reindexThreshold() || broken
            || fullReindexOf(previous) || !preservedRemoved(previous).isEmpty();

        // Cold start with no dirty entries still has work: the index does not exist
        // yet. Only a warm index with nothing changed is a no-op — the previous
        // guard returned here too, so `update` on a fresh root never built anything.
        if (dirty.isEmpty() && !fullRun && hasIndex && !firstRun) {
            // Nothing to do, so the build marker written above must not survive: it
            // would claim a run that never started.
            writeManifest(config, indexRoot, unionDirty(indexRoot, dirty),
                unionRemoved(indexRoot, preservedRemoved(previous)), fullReindexOf(previous),
                restoredState(previous));
            System.out.println("[update] dirty-set empty, nothing to do");
            return;
        }

        var inputDir = indexRoot.resolve("input");
        // Deleted sources must leave the corpus even on a full rebuild: a full export
        // writes every current source but knows nothing about removals.
        var removedSources = unionRemoved(indexRoot, preservedRemoved(previous));
        if (!removedSources.isEmpty()) {
            int dropped = removeDocsForSources(inputDir, removedSources);
            System.out.println("[update] removed=" + dropped + " docs for deleted sources");
        }
        if (!fullRun) {
            int removed = removeDocsForSources(inputDir, dirty);
            System.out.println("[update] removed=" + removed + " docs for dirty sources");
        } else {
            System.out.println("[update] full reindex — dirty=" + dirty.size()
                + " threshold=" + config.reindexThreshold()
                + " previous_status=" + previous.map(Manifest::status).orElse(Manifest.STATUS_UNKNOWN));
        }

        int exported = 0;
        try {
            // A cold start or a full rebuild exports the whole corpus. Passing the
            // (empty) dirty list would be read as a file filter and export nothing —
            // the same end state as a broken exporter, with no error raised.
            boolean exportAll = fullRun || firstRun || !hasIndex || dirty.isEmpty();
            var stats = ExportCli.export(config, indexRoot, exportAll ? null : dirty);
            exported = stats.exported();
        } catch (Exception e) {
            e.printStackTrace();
        }

        // GraphRAG `update` cannot bootstrap: it needs an existing
        // output/documents.parquet to diff against. Cold start (no output dir,
        // or no manifest) and a full rebuild must run `index` on whatever
        // documents are present. After that, `update` works.
        String subcommand = (fullRun || firstRun || !hasIndex) ? SUBCOMMAND_INDEX : SUBCOMMAND_UPDATE;
        boolean staged = SUBCOMMAND_UPDATE.equals(subcommand);

        long runStartMs = System.currentTimeMillis();
        int exit = runGraphrag(config, indexRoot, subcommand);
        boolean claims = claimsEnabled(indexRoot);
        // `update` stages its output under update_output/<timestamp>/, `index` writes
        // output/ directly. The staged directory is created *during* the run, so the
        // gate must read it after the process has exited — a gateDir captured before
        // the run would name the previous run's directory and fail a fresh success.
        var gateDir = staged ? newestUpdateOutput(indexRoot).orElse(outputDir) : outputDir;

        if (exit != 0) {
            writeManifest(config, indexRoot, unionDirty(indexRoot, dirty),
                unionRemoved(indexRoot, preservedRemoved(previous)), fullReindexOf(previous),
                LifecycleState.failedRun(
                "graphrag " + subcommand + " exit " + exit, failuresAfter(previous),
                lastGoodBuild(previous), presentArtifacts(indexRoot, gateDir, runStartMs, claims)));
            throw new IOException("[update] graphrag " + subcommand + " failed with exit code " + exit);
        }

        var missing = missingArtifacts(indexRoot, gateDir, runStartMs, claims);
        var present = presentArtifacts(indexRoot, gateDir, runStartMs, claims);

        if (!missing.isEmpty()) {
            // FS-2: the baseline index stays exactly as it was — a partial run never
            // promotes its staged output, so queries keep seeing the last good build.
            writeManifest(config, indexRoot, unionDirty(indexRoot, dirty),
                unionRemoved(indexRoot, preservedRemoved(previous)), fullReindexOf(previous),
                LifecycleState.partial(
                missing, failuresAfter(previous), lastGoodBuild(previous), present));
            reportIncomplete("update", missing);
            return;
        }

        if (staged) promote(indexRoot);
        writeManifest(config, indexRoot, dirtyRecordedDuringRun(indexRoot, dirty), List.of(), false,
            LifecycleState.complete(present));
        System.out.println("[update] done — " + exported + " blocks indexed");
    }

    /** One line on each stream: the run is recorded as partial, and the caller is told which files. */
    private static void reportIncomplete(String stage, List<String> missing) {
        var line = "[" + stage + "] INCOMPLETE — missing: " + String.join(", ", missing);
        System.out.println(line);
        System.err.println(line);
    }

    static void status(ExportConfig config, Path indexRoot) throws IOException {
        var manifestFile = indexRoot.resolve(MANIFEST_FILE);
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

        // FS-4: the gate fields are the data lines the plugin host composes its
        // status block from, followed by the checklist of what the disk holds now.
        System.out.println("schema: " + manifest.schema());
        System.out.println("status: " + orNone(manifest.status()));
        System.out.println("last_good_build: " + orNone(manifest.lastGoodBuild()));
        System.out.println("consecutive_failures: " + manifest.consecutiveFailures());
        System.out.println("partial_reason: " + orNone(manifest.partialReason()));
        System.out.println("failure_reason: " + orNone(manifest.failureReason()));
        System.out.println("artifacts_present: " + String.join(", ", manifest.artifactsPresent()));
        System.out.println("removed: " + manifest.removed().size());
        for (var r : manifest.removed()) System.out.println("  " + r);
        System.out.println("full_reindex: " + manifest.fullReindex());

        var outputDir = indexRoot.resolve(OUTPUT_DIR);
        for (var name : requiredArtifacts(claimsEnabled(indexRoot))) {
            // runStartMs 0 makes the mtime rule vacuous: status reports what exists.
            boolean present = artifactPresent(indexRoot, outputDir, name, 0L);
            System.out.println("artifact " + name + ": " + (present ? "present" : "MISSING"));
        }
    }

    /**
     * FS-2 completion gate. Returns the artifacts a run should have produced but did
     * not; an empty list means the index counts as complete.
     *
     * <p>A file passes when it exists, is non-empty, and was written by <em>this</em>
     * run ({@code lastModified >= runStartMs - 5 s}). The mtime rule is what separates a
     * fresh artifact from one left behind by an earlier build.
     */
    static List<String> missingArtifacts(Path indexRoot, Path artifactDir, long runStartMs,
                                         boolean claimsEnabled) {
        return requiredArtifacts(claimsEnabled).stream()
            .filter(name -> !artifactPresent(indexRoot, artifactDir, name, runStartMs))
            .toList();
    }

    /** The required artifacts that are on disk for this run; the complement of {@link #missingArtifacts}. */
    static List<String> presentArtifacts(Path indexRoot, Path artifactDir, long runStartMs,
                                         boolean claimsEnabled) {
        return requiredArtifacts(claimsEnabled).stream()
            .filter(name -> artifactPresent(indexRoot, artifactDir, name, runStartMs))
            .toList();
    }

    /** The full required set for a run, including the claim artifact and the vector store. */
    static List<String> requiredArtifacts(boolean claimsEnabled) {
        var required = new ArrayList<>(REQUIRED_ARTIFACTS);
        if (claimsEnabled) required.add(CLAIMS_ARTIFACT);
        required.add(VECTOR_STORE_DIR);
        return List.copyOf(required);
    }

    /**
     * Whether one required artifact is present for this run. An unreadable path counts
     * as absent: the gate must never pass on evidence it could not read.
     */
    static boolean artifactPresent(Path indexRoot, Path artifactDir, String name, long runStartMs) {
        if (VECTOR_STORE_DIR.equals(name)) {
            var vectorStore = indexRoot.resolve(VECTOR_STORE_DIR);
            if (!Files.isDirectory(vectorStore)) return false;
            try (var entries = Files.list(vectorStore)) {
                return entries.findAny().isPresent();
            } catch (IOException unreadable) {
                return false;
            }
        }
        var artifact = artifactDir.resolve(name);
        try {
            return Files.isRegularFile(artifact)
                && Files.size(artifact) > 0
                && Files.getLastModifiedTime(artifact).toMillis() >= runStartMs - GATE_MTIME_SLACK_MS;
        } catch (IOException unreadable) {
            return false;
        }
    }

    /**
     * Whether {@code settings.yaml} enables claim extraction, which is what makes
     * {@code covariates.parquet} a required artifact rather than an optional one.
     */
    static boolean claimsEnabled(Path indexRoot) throws IOException {
        var settings = indexRoot.resolve(SETTINGS_FILE);
        if (!Files.isRegularFile(settings)) return false;
        boolean inClaimsBlock = false;
        for (var raw : Files.readAllLines(settings)) {
            var line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) continue;
            if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
                inClaimsBlock = line.equals(CLAIMS_SETTINGS_KEY);
                continue;
            }
            if (inClaimsBlock && line.equals(CLAIMS_ENABLED_LINE)) return true;
        }
        return false;
    }

    /**
     * Newest staged update directory under {@code update_output/}, chosen by directory
     * name (GraphRAG names them by timestamp) with creation time as tie-break.
     */
    static Optional<Path> newestUpdateOutput(Path indexRoot) throws IOException {
        var updateOutput = indexRoot.resolve(UPDATE_OUTPUT_DIR);
        if (!Files.isDirectory(updateOutput)) return Optional.empty();
        try (var entries = Files.list(updateOutput)) {
            return entries
                .filter(Files::isDirectory)
                .max(Comparator
                    .comparing((Path dir) -> dir.getFileName().toString())
                    .thenComparingLong(IndexCli::creationMillis));
        }
    }

    private static long creationMillis(Path dir) {
        try {
            return Files.readAttributes(dir, BasicFileAttributes.class).creationTime().toMillis();
        } catch (IOException unreadable) {
            return 0L;
        }
    }

    /** Reads the manifest, or reports its absence/corruption once and returns empty. */
    static Optional<Manifest> readManifestTolerant(Path manifestFile) {
        if (!Files.isRegularFile(manifestFile)) return Optional.empty();
        try {
            return Optional.of(Manifest.fromJson(Files.readString(manifestFile)));
        } catch (IOException | RuntimeException unreadable) {
            System.err.println("[manifest] ignoring unreadable " + manifestFile + ": "
                + unreadable.getMessage());
            return Optional.empty();
        }
    }

    static List<String> preservedDirty(Optional<Manifest> previous) {
        return previous.map(Manifest::dirty).orElse(List.of());
    }

    /**
     * Dirty entries recorded by the plugin host while this run was executing. They
     * name sources the run never exported, so a completed run must keep them (the
     * index is then complete but stale, and the next run picks them up).
     */
    static List<String> dirtyRecordedDuringRun(Path indexRoot, List<String> startDirty) {
        var before = new HashSet<>(startDirty);
        return readManifestTolerant(indexRoot.resolve(MANIFEST_FILE))
            .map(Manifest::dirty)
            .orElse(List.of())
            .stream()
            .filter(entry -> !before.contains(entry))
            .toList();
    }

    /** Start-of-run dirty set unioned with anything recorded during the run (no loss on failure). */
    static List<String> unionDirty(Path indexRoot, List<String> startDirty) {
        var merged = new LinkedHashSet<>(startDirty);
        readManifestTolerant(indexRoot.resolve(MANIFEST_FILE)).ifPresent(m -> merged.addAll(m.dirty()));
        return List.copyOf(merged);
    }

    static List<String> preservedRemoved(Optional<Manifest> previous) {
        return previous.map(Manifest::removed).orElse(List.of());
    }

    /** Removals must survive a failed run too: their documents are still in the corpus. */
    static List<String> unionRemoved(Path indexRoot, List<String> startRemoved) {
        var merged = new LinkedHashSet<>(startRemoved);
        readManifestTolerant(indexRoot.resolve(MANIFEST_FILE)).ifPresent(m -> merged.addAll(m.removed()));
        return List.copyOf(merged);
    }

    static boolean fullReindexOf(Optional<Manifest> previous) {
        return previous.map(Manifest::fullReindex).orElse(false);
    }

    static int failuresAfter(Optional<Manifest> previous) {
        return previous.map(Manifest::consecutiveFailures).orElse(0) + 1;
    }

    static String lastGoodBuild(Optional<Manifest> previous) {
        return previous.map(Manifest::lastGoodBuild).orElse(null);
    }

    /** The state to keep when a run turns out to have no work: what was true before it started. */
    static LifecycleState restoredState(Optional<Manifest> previous) {
        return previous
            .map(m -> new LifecycleState(
                m.status() == null || m.status().isBlank() ? STATUS_IDLE : m.status(),
                m.lastGoodBuild(), m.partialReason(), m.failureReason(),
                m.consecutiveFailures(), m.artifactsPresent()))
            .orElseGet(() -> new LifecycleState(STATUS_IDLE, null, null, null, 0, List.of()));
    }

    /** Build marker: the run has started and has not yet produced a verdict. */
    static void markBuilding(ExportConfig config, Path indexRoot, Optional<Manifest> previous)
            throws IOException {
        writeManifest(config, indexRoot, preservedDirty(previous),
            preservedRemoved(previous), fullReindexOf(previous),
            LifecycleState.building(previous));
    }

    private static String orNone(String value) {
        return value == null || value.isBlank() ? "none" : value;
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
        // A killed CLI must not orphan graphrag: the child keeps the model's
        // connections and the cache warm with no supervisor, and a single-slot
        // backend then serves a "dead" run forever. Take the child down with us.
        var hook = new Thread(() -> {
            if (!proc.isAlive()) return;
            proc.destroy();
            try {
                proc.waitFor(10, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            if (proc.isAlive()) proc.destroyForcibly();
        }, "graphrag-child-reaper");
        Runtime.getRuntime().addShutdownHook(hook);
        try {
            return proc.waitFor();
        } finally {
            try {
                Runtime.getRuntime().removeShutdownHook(hook);
            } catch (IllegalStateException alreadyShuttingDown) {
                // the hook is running or the JVM is exiting — nothing to remove
            }
        }
    }

    static void promote(Path indexRoot) throws IOException {
        // Promote the staged tree: the newest timestamped directory graphrag `update`
        // wrote. Moving the whole update_output/ directory would nest the timestamped
        // subdirectories inside output/, so output/documents.parquet would never exist
        // and the next run could not detect a warm index.
        var latest = newestUpdateOutput(indexRoot);
        if (latest.isEmpty()) {
            System.err.println("[promote] no staged update directory — skipping promotion");
            return;
        }
        var output = indexRoot.resolve(OUTPUT_DIR);
        var staging = indexRoot.resolve(OUTPUT_DIR + ".promoting");
        Files.deleteIfExists(staging);
        Files.move(latest.get(), staging);
        if (Files.exists(output)) deleteRecursive(output);
        Files.move(staging, output);
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

    /**
     * Writes the manifest atomically. The gate fields travel as one {@link LifecycleState}
     * value; the identity fields come from the project and the installed binary.
     */
    static void writeManifest(ExportConfig config, Path indexRoot, List<String> dirty,
                              List<String> removed, boolean fullReindex,
                              LifecycleState state) throws IOException {
        writeManifestFile(indexRoot, buildManifest(config, dirty, removed, fullReindex, state));
    }

    static Manifest buildManifest(ExportConfig config, List<String> dirty, List<String> removed,
                                  boolean fullReindex, LifecycleState state) {
        var commit = gitCommit(config.projectRoot());
        var version = graphragVersion(config.graphragBinary());
        var binary = resolveBinary(config.graphragBinary());
        return new Manifest(
            Manifest.SCHEMA_VERSION,
            commit != null ? commit : "",
            Instant.now().toString(),
            version != null ? version : "",
            binary != null ? binary : config.graphragBinary(),
            List.copyOf(dirty),
            List.copyOf(removed),
            fullReindex,
            state.status(),
            state.lastGoodBuild(),
            state.partialReason(),
            state.failureReason(),
            state.consecutiveFailures(),
            state.artifactsPresent()
        );
    }

    /** Atomic write: tmp file, then rename. A reader never sees a half-written manifest. */
    static void writeManifestFile(Path indexRoot, Manifest manifest) throws IOException {
        Files.createDirectories(indexRoot);
        // The plugin host and the standalone reconcile service both merge into this
        // file. Rename makes each write atomic; this lock makes the merge atomic.
        var lock = indexRoot.resolve(MANIFEST_FILE + ".lock");
        long deadline = System.currentTimeMillis() + 2_000;
        while (true) {
            try {
                Files.createFile(lock);
                break;
            } catch (FileAlreadyExistsException busy) {
                try {
                    long age = System.currentTimeMillis() - Files.getLastModifiedTime(lock).toMillis();
                    if (age > 30_000) {
                        Files.deleteIfExists(lock); // a crashed holder must not wedge the lock
                        continue;
                    }
                } catch (IOException ignored) { /* released between create and stat */ }
                if (System.currentTimeMillis() > deadline) {
                    System.err.println("[manifest] lock busy; writing without it");
                    break;
                }
                try {
                    Thread.sleep(20);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        try {
            var tmp = indexRoot.resolve(MANIFEST_FILE + ".tmp");
            Files.writeString(tmp, manifest.toJson());
            Files.move(tmp, indexRoot.resolve(MANIFEST_FILE),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
        } finally {
            try {
                Files.deleteIfExists(lock);
            } catch (IOException ignored) { /* best effort */ }
        }
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
        sb.append("    concurrent_requests: ").append(config.chatConcurrentRequests()).append("\n");
        // Batch extraction must not spend its budget on reasoning traces: without an
        // effort cap a reasoning model can return zero content within max_tokens.
        if (!config.chatReasoningEffort().isBlank()) {
            sb.append("    reasoning_effort: ").append(config.chatReasoningEffort()).append("\n");
        }
        if (config.chatMaxTokens() > 0) sb.append("    max_tokens: ").append(config.chatMaxTokens()).append("\n");
        if (config.chatRequestTimeout() > 0) {
            sb.append("    request_timeout: ").append(config.chatRequestTimeout()).append("\n");
        }
        if (config.chatTokensPerMinute() > 0) {
            sb.append("    tokens_per_minute: ").append(config.chatTokensPerMinute()).append("\n");
            sb.append("    rate_limit_strategy: rolling\n");
        }
        if (config.chatRequestsPerMinute() > 0) {
            sb.append("    requests_per_minute: ").append(config.chatRequestsPerMinute()).append("\n");
        }
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
        sb.append("    concurrent_requests: ").append(config.embeddingConcurrentRequests()).append("\n");
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
            long ownerPid = -1;
            try {
                ownerPid = Long.parseLong(content[0]);
            } catch (Exception ignored) {}
            if (ownerPid > 0 && !ProcessHandle.of(ownerPid).isEmpty()) {
                // Owner process is alive — the lock is genuinely held. Never steal
                // from a live owner, regardless of age, or a slow-but-healthy job
                // would be clobbered by a concurrent one.
                return false;
            }
            // Owner is dead (or unknown PID). Steal the lock unless it is fresh
            // *and* its owner simply could not be checked — i.e. only treat a
            // fresh lock with an unparseable PID as held.
            if (ownerPid <= 0) {
                try {
                    var ts = content.length >= 2 ? Instant.parse(content[1]) : null;
                    boolean fresh = ts != null
                        && Instant.now().getEpochSecond() - ts.getEpochSecond() < STALE_LOCK_SECONDS;
                    if (fresh) {
                        return false;
                    }
                } catch (Exception ignored) {}
            }
            Files.deleteIfExists(lock);
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
