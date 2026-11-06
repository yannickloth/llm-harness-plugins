package eu.infolead.llmhp.graphrag;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.util.*;
import eu.infolead.llmhp.graphrag.types.Manifest;

/**
 * Completion-gate and manifest tests (spec FS-2, FS-3 data layer, A7).
 * Plain main() self-test, matching ExportTest's convention.
 */
public class IndexCliGateTest {

    static int passed = 0;
    static int failed = 0;

    static void check(String label, boolean condition) {
        if (condition) {
            passed++;
        } else {
            failed++;
            System.err.println("FAIL [" + label + "]");
        }
    }

    static Path fresh(String name) throws IOException {
        var dir = Path.of("build", "test-tmp-graphrag-gate", name);
        if (Files.exists(dir)) deleteRecursive(dir);
        Files.createDirectories(dir);
        return dir;
    }

    static void deleteRecursive(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
        }
    }

    static void writeArtifact(Path dir, String name, int bytes, long mtimeMs) throws IOException {
        Files.createDirectories(dir);
        var f = dir.resolve(name);
        Files.writeString(f, bytes > 0 ? "x".repeat(bytes) : "");
        Files.setLastModifiedTime(f, FileTime.fromMillis(mtimeMs));
    }

    public static void main(String[] args) throws Exception {
        long now = System.currentTimeMillis();
        var artifacts = List.of(
            "documents.parquet", "text_units.parquet", "entities.parquet",
            "relationships.parquet", "communities.parquet", "community_reports.parquet",
            "covariates.parquet");

        // 1. Empty fixture: every required entry is missing.
        var empty = fresh("empty");
        var missingEmpty = IndexCli.missingArtifacts(empty, empty.resolve("output"), now, true);
        check("empty: all required missing",
            missingEmpty.size() == artifacts.size() + 1 && missingEmpty.contains("lancedb"));

        // 2. Complete fixture: gate passes.
        var good = fresh("good");
        var out = good.resolve("output");
        for (var name : artifacts) writeArtifact(out, name, 10, now);
        Files.createDirectories(good.resolve("lancedb"));
        Files.writeString(good.resolve("lancedb").resolve("table.lance"), "x");
        check("full: gate passes", IndexCli.missingArtifacts(good, out, now, true).isEmpty());
        check("strip latex noise", ExportCli.stripLatexNoise("Principle~\\ref{prc:ivp} stated")
            .equals("Principle stated"));

        // 3. Zero-size file counts as missing (a crashed writer leaves empty parquets).
        writeArtifact(out, "entities.parquet", 0, now);
        check("zero-size counts missing",
            IndexCli.missingArtifacts(good, out, now, true).equals(List.of("entities.parquet")));

        // 4. Old mtime counts as missing (leftover from an earlier build).
        writeArtifact(out, "entities.parquet", 10, now - 10 * 3600_000L);
        check("old mtime counts missing",
            IndexCli.missingArtifacts(good, out, now, true).equals(List.of("entities.parquet")));

        // 5. Claims toggle: covariates is required only when claims are enabled.
        check("claims off drops covariates",
            !IndexCli.requiredArtifacts(false).contains("covariates.parquet"));
        check("claims on requires covariates",
            IndexCli.requiredArtifacts(true).contains("covariates.parquet"));

        // 6. Missing vector store is listed.
        deleteRecursive(good.resolve("lancedb"));
        check("lancedb missing listed",
            IndexCli.missingArtifacts(good, out, now, false).contains("lancedb"));

        // 7. Manifest round-trip keeps every gate field.
        var m = new Manifest(
            Manifest.SCHEMA_VERSION, "abc123", "2026-11-05T00:00:00Z", "2.7.0", "/nix/graphrag",
            List.of("a.typ", "b.typ"), List.of("old.tex"), true, "partial", "2026-10-01T00:00:00Z",
            "missing: entities.parquet", null, 2, List.of("documents.parquet"));
        var back = Manifest.fromJson(m.toJson());
        check("roundtrip status", "partial".equals(back.status()));
        check("roundtrip last_good_build", "2026-10-01T00:00:00Z".equals(back.lastGoodBuild()));
        check("roundtrip partial_reason", "missing: entities.parquet".equals(back.partialReason()));
        check("roundtrip failure_reason null", back.failureReason() == null);
        check("roundtrip consecutive_failures", back.consecutiveFailures() == 2);
        check("roundtrip artifacts_present", back.artifactsPresent().equals(List.of("documents.parquet")));
        check("roundtrip dirty", back.dirty().equals(List.of("a.typ", "b.typ")));
        check("roundtrip removed", back.removed().equals(List.of("old.tex")));
        check("roundtrip full_reindex", back.fullReindex());
        check("roundtrip schema", back.schema() == Manifest.SCHEMA_VERSION);

        // 8. Schema-1 manifest (the Aug-7 shape) parses with defaults, never throws.
        var legacy = """
            {
              "commit": "deadbeef",
              "timestamp": "2026-08-07T13:10:00Z",
              "graphrag_version": "2.7.0",
              "graphrag_binary": "graphrag",
              "dirty": ["x.typ"]
            }""";
        var lm = Manifest.fromJson(legacy);
        check("legacy schema 1", lm.schema() == 1);
        check("legacy status unknown", Manifest.STATUS_UNKNOWN.equals(lm.status()));
        check("legacy failures 0", lm.consecutiveFailures() == 0);
        check("legacy reasons null", lm.partialReason() == null && lm.failureReason() == null);
        check("legacy dirty preserved", lm.dirty().equals(List.of("x.typ")));
        check("legacy removed empty", lm.removed().isEmpty());
        check("legacy full_reindex false", !lm.fullReindex());

        // 9. Dirty-set reconciliation: entries the plugin recorded during the run
        // survive a completed run (and are never lost on a failed one).
        var rec = fresh("reconcile");
        var man = rec.resolve("manifest.json");
        Files.writeString(man, """
            {"schema": 2, "commit": "c", "timestamp": "t", "graphrag_version": "2.7.0",
             "graphrag_binary": "graphrag", "dirty": ["a.typ"], "status": "building"}""");
        check("union keeps start entries",
            IndexCli.unionDirty(rec, List.of("a.typ")).equals(List.of("a.typ")));
        Files.writeString(man, """
            {"schema": 2, "commit": "c", "timestamp": "t", "graphrag_version": "2.7.0",
             "graphrag_binary": "graphrag", "dirty": ["a.typ", "b.typ"], "status": "building"}""");
        check("union absorbs during-run entries",
            IndexCli.unionDirty(rec, List.of("a.typ")).equals(List.of("a.typ", "b.typ")));
        check("complete keeps only during-run entries",
            IndexCli.dirtyRecordedDuringRun(rec, List.of("a.typ")).equals(List.of("b.typ")));

        System.out.println("IndexCliGateTest: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
