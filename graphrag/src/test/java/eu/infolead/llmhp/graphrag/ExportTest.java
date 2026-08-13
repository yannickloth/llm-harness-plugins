package eu.infolead.llmhp.graphrag;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.graphrag.DocumentWriter.ExportedDocument;
import eu.infolead.llmhp.graphrag.LatexExporter.LatexChunk;
import eu.infolead.llmhp.graphrag.types.ExportConfig;
import eu.infolead.llmhp.graphrag.types.Manifest;
import eu.infolead.llmhp.graphrag.types.SemanticBlock;
import eu.infolead.llmhp.graphrag.types.SemanticBlock.Kind;

public class ExportTest {

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

    static Path tmpDir() throws IOException {
        var dir = Path.of("build", "test-tmp-graphrag");
        Files.createDirectories(dir);
        return dir;
    }

    static void cleanup() throws IOException {
        var dir = Path.of("build", "test-tmp-graphrag");
        if (Files.exists(dir)) {
            try (var walk = Files.walk(dir)) {
                walk.sorted(Comparator.reverseOrder())
                    .map(Path::toFile)
                    .forEach(File::delete);
            }
        }
    }

    // --- Typst splitting ---

    static void testTypstTheoremWithClaim() {
        var splitter = new TypstBlockSplitter();
        var content = """
            #import "../../../../../lib.typ": *

            #theorem(name: [Variation Equivalence], hypotheses: none, claim: ([
              For a fixed driver $gamma in C$, the relation is an equivalence relation.
              Specifically, for all $e_i, e_j in E_gamma$: $e_i sim e_j$ holds.],)) <thm:variation-equivalence>
            """;
        var result = splitter.split(content, "volume-1/part1/ch05/claims/thm-x.typ");
        var formal = result.blocks().stream().filter(SemanticBlock::isFormal).toList();
        assert_equals("theorem: one formal block", 1, formal.size());
        var block = formal.getFirst();
        assert_equals("theorem: kind", Kind.THEOREM, block.kind());
        assert_equals("theorem: label", "thm:variation-equivalence", block.label());
        assert_equals("theorem: name", "Variation Equivalence", block.name());
        assert_true("theorem: body contains claim",
            block.body().contains("equivalence relation"));
        assert_true("theorem: math kept verbatim",
            block.body().contains("$gamma in C$"));
        assert_true("theorem: import stripped",
            !block.body().contains("#import"));
    }

    static void testTypstProofWithStrategy() {
        var splitter = new TypstBlockSplitter();
        var content = """
            #proof(name: [Proof of Variation Equivalence], strategy: [direct proof])[
              Let $gamma in C$. Reflexivity holds by definition.
            ]
            """;
        var result = splitter.split(content, "volume-1/proof.typ");
        var formal = result.blocks().stream().filter(SemanticBlock::isFormal).toList();
        assert_equals("proof: one formal block", 1, formal.size());
        var block = formal.getFirst();
        assert_equals("proof: kind", Kind.PROOF, block.kind());
        assert_true("proof: strategy encoded", block.body().contains("[strategy: direct proof]"));
        assert_true("proof: body kept", block.body().contains("Reflexivity holds"));
    }

    static void testTypstSimpleEnvWithLabel() {
        var splitter = new TypstBlockSplitter();
        var content = """
            #assumption(name: [Change Management Hypothesis])[
              The primary purpose of software architecture is to minimize cost.
            ] <asm:change-management-hypothesis>
            """;
        var result = splitter.split(content, "volume-1/def-x.typ");
        var formal = result.blocks().stream().filter(SemanticBlock::isFormal).toList();
        assert_equals("assumption: one block", 1, formal.size());
        assert_equals("assumption: kind", Kind.ASSUMPTION, formal.getFirst().kind());
        assert_equals("assumption: label", "asm:change-management-hypothesis",
            formal.getFirst().label());
        assert_true("assumption: labels collected",
            result.labels().contains("asm:change-management-hypothesis"));
    }

    static void testTypstProseAndHeadings() {
        var splitter = new TypstBlockSplitter();
        var content = """
            Some introductory prose here.

            == First Section

            Prose inside the first section with a reference @def:driver.

            == Second Section

            More prose.
            """;
        var result = splitter.split(content, "volume-1/sec.typ");
        var sections = result.blocks().stream().filter(b -> b.kind() == Kind.SECTION).toList();
        assert_equals("prose: two sections", 2, sections.size());
        assert_equals("prose: section name", "First Section", sections.getFirst().name());
        assert_true("prose: ref extracted",
            sections.getFirst().refs().contains("def:driver"));
        var prose = result.blocks().stream().filter(b -> b.kind() == Kind.PROSE).toList();
        assert_equals("prose: one intro block", 1, prose.size());
    }

    static void testTypstMultipleEnvsInOneFile() {
        var splitter = new TypstBlockSplitter();
        var content = """
            #assumption(name: [CMH])[
              Architecture minimizes cost.
            ] <asm:cmh>

            #remark[
              The name is historical. See @ch:cmh-developments.
            ] <rem:cmh-normative-postulate>
            """;
        var result = splitter.split(content, "volume-1/defs.typ");
        var formal = result.blocks().stream().filter(SemanticBlock::isFormal).toList();
        assert_equals("multi-env: two blocks", 2, formal.size());
        assert_equals("multi-env: first kind", Kind.ASSUMPTION, formal.get(0).kind());
        assert_equals("multi-env: second kind", Kind.REMARK, formal.get(1).kind());
        assert_true("multi-env: remark ref",
            formal.get(1).refs().contains("ch:cmh-developments"));
    }

    static void testTypstCommentStripping() {
        var splitter = new TypstBlockSplitter();
        var content = """
            // prereq-ok: motivational forward-pointer KI
            #key-insight[
              IVP-compliant architecture localizes domain knowledge.
            ]
            """;
        var result = splitter.split(content, "volume-1/ki.typ");
        var formal = result.blocks().stream().filter(SemanticBlock::isFormal).toList();
        assert_equals("comment: one block", 1, formal.size());
        assert_equals("comment: kind", Kind.KEY_INSIGHT, formal.getFirst().kind());
        assert_true("comment: comment not in body",
            !formal.getFirst().body().contains("prereq-ok"));
    }

    // --- LaTeX path ---

    static void testLatexTheoremSplit() {
        var latex = new LatexExporter("pandoc");
        var content = """
            \\begin{assumption}[Change Management Hypothesis]
            \\t\\label{asm:change-management-hypothesis}%
            \\tThe change management hypothesis holds.
            \\end{assumption}
            """;
        var chunks = latex.split(content, "src/legacy/latex/volume-1/def-x.tex");
        assert_equals("latex: one chunk", 1, chunks.size());
        var chunk = chunks.getFirst();
        assert_equals("latex: kind", Kind.ASSUMPTION, chunk.kind());
        assert_equals("latex: label", "asm:change-management-hypothesis", chunk.label());
        assert_true("latex: body kept", chunk.latexBody().contains("change management hypothesis"));
        assert_true("latex: begin/end stripped",
            !chunk.latexBody().contains("\\begin{assumption}"));
    }

    static void testLatexSectionSplit() {
        var latex = new LatexExporter("pandoc");
        var content = """
            \\section{Introduction}
            Some intro text.
            \\begin{theorem}
            \\label{thm:sample}
            A claim (Definition~\\ref{def:driver}).
            \\end{theorem}
            Trailing prose.
            """;
        var chunks = latex.split(content, "src/legacy/latex/paper.tex");
        assert_true("latex-section: >= 3 chunks", chunks.size() >= 3);
        assert_equals("latex-section: first is section", Kind.SECTION, chunks.getFirst().kind());
        assert_equals("latex-section: section name", "Introduction", chunks.getFirst().name());
        var thm = chunks.stream().filter(c -> c.kind() == Kind.THEOREM).toList();
        assert_equals("latex-section: theorem found", 1, thm.size());
        assert_equals("latex-section: theorem label", "thm:sample", thm.getFirst().label());
        assert_true("latex-section: ref extracted", thm.getFirst().refs().contains("def:driver"));
    }

    static void testLatexCommentStripping() {
        var latex = new LatexExporter("pandoc");
        var content = """
            Visible text % this comment disappears
            \\begin{definition}
            \\label{def:x}
            Content with 50\\% percent.
            \\end{definition}
            """;
        var chunks = latex.split(content, "src/legacy/latex/x.tex");
        var all = String.join("\n", chunks.stream().map(LatexChunk::latexBody).toList());
        assert_true("latex-comment: comment stripped", !all.contains("this comment disappears"));
        assert_true("latex-comment: escaped percent kept", all.contains("50\\%"));
    }

    static void testLatexMarkdownConversion() {
        if (!pandocAvailable()) {
            System.out.println("SKIP [latex-md] pandoc not on PATH (run under direnv for full coverage)");
            return;
        }
        var latex = new LatexExporter("pandoc");
        var md = latex.toMarkdown("The \\emph{change management hypothesis} holds.");
        assert_true("latex-md: emph converted",
            md.contains("*change management hypothesis*"));
    }

    static boolean pandocAvailable() {
        try {
            var proc = new ProcessBuilder("pandoc", "--version").redirectErrorStream(true).start();
            return proc.waitFor() == 0;
        } catch (IOException | InterruptedException e) {
            return false;
        }
    }

    // --- Deduplication ---

    static void testDeduplication() throws IOException {
        var dir = tmpDir().resolve("dedup");
        var typstDir = dir.resolve("src/main/typst/volume-1");
        var latexDir = dir.resolve("src/legacy/latex/volume-1");
        Files.createDirectories(typstDir);
        Files.createDirectories(latexDir);
        Files.writeString(typstDir.resolve("def-x.typ"),
            "#definition[Typst version.] <def:shared-concept>\n");
        Files.writeString(latexDir.resolve("def-x.tex"), """
            \\begin{definition}
            \\label{def:shared-concept}
            LaTeX version.
            \\end{definition}
            """);
        Files.writeString(latexDir.resolve("def-y.tex"), """
            \\begin{definition}
            \\label{def:latex-only}
            Only in LaTeX.
            \\end{definition}
            """);

        var config = new ExportConfig("test", dir,
            "src/legacy/latex", List.of(".git"),
            new ExportConfig.Models("", "", "", "", "", "", ""),
            false, 0, "graphrag", "graph-index");
        var typstLabels = ExportCli.collectTypstLabels(config);
        assert_true("dedup: typst label collected", typstLabels.contains("def:shared-concept"));
        assert_true("dedup: latex-only not in typst set", !typstLabels.contains("def:latex-only"));

        var latex = new LatexExporter("pandoc");
        var dupes = ExportCli.findDuplicates(config, typstLabels, latex);
        assert_equals("dedup: one duplicate", 1, dupes.size());
        assert_true("dedup: duplicate is shared-concept",
            dupes.getFirst().contains("def:shared-concept"));
    }

    // --- DocumentWriter ---

    static void testFrontmatterRendering() {
        var block = new SemanticBlock(Kind.THEOREM, "thm:partition", "Partition Theorem",
            "The claim body.", "src/main/typst/volume-1/part2/ch04/sec.typ", 42,
            List.of("def:driver", "def:gamma"));
        var doc = new ExportedDocument("volume-1-theorem-thm-partition",
            "volume-1", "typst", "primary", block);
        var rendered = DocumentWriter.render(doc, List.of("vol:1", "ch:04"));

        assert_true("frontmatter: id", rendered.contains("id: volume-1-theorem-thm-partition"));
        assert_true("frontmatter: lang", rendered.contains("lang: typst"));
        assert_true("frontmatter: authority", rendered.contains("authority: primary"));
        assert_true("frontmatter: env", rendered.contains("env: theorem"));
        assert_true("frontmatter: labels", rendered.contains("labels: [thm:partition]"));
        assert_true("frontmatter: refs", rendered.contains("refs: [def:driver, def:gamma]"));
        assert_true("frontmatter: file", rendered.contains("file: src/main/typst/volume-1/part2/ch04/sec.typ"));
        assert_true("frontmatter: line", rendered.contains("line: 42"));
        assert_true("markers: label marker", rendered.contains("[THEOREM label=thm:partition]"));
        assert_true("markers: cites marker", rendered.contains("[THEOREM cites: def:driver, def:gamma]"));
        assert_true("markers: appears_in", rendered.contains("[SECTION appears_in: vol:1, ch:04]"));
        assert_true("body: name rendered", rendered.contains("**Partition Theorem**"));
        assert_true("body: claim kept", rendered.contains("The claim body."));
    }

    static void testDocIdAndSha() {
        var block = new SemanticBlock(Kind.THEOREM, "thm:partition", null, "x", "f.typ", 1, List.of());
        var doc = new ExportedDocument("", "volume-1", "typst", "primary", block);
        assert_equals("docId", "volume-1-theorem-thm-partition", DocumentWriter.docId(doc));

        var sha1 = DocumentWriter.sha8("content");
        var sha2 = DocumentWriter.sha8("content");
        var sha3 = DocumentWriter.sha8("other");
        assert_equals("sha8: stable", sha1, sha2);
        assert_true("sha8: differs", !sha1.equals(sha3));
        assert_equals("sha8: length", 8, sha1.length());

        var noLabel = new SemanticBlock(Kind.PROSE, null, null, "x", "f.typ", 7, List.of());
        var doc2 = new ExportedDocument("", "volume-1", "typst", "primary", noLabel);
        assert_true("docId: prose fallback", DocumentWriter.docId(doc2).startsWith("volume-1-prose-"));
    }

    static void testRemoveStale() throws IOException {
        var dir = tmpDir().resolve("stale/input");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("doc-a--11111111.md"), "old");
        Files.writeString(dir.resolve("doc-a--22222222.md"), "old2");
        Files.writeString(dir.resolve("doc-b--33333333.md"), "keep");
        var removed = DocumentWriter.removeStale(dir, "doc-a");
        assert_equals("removeStale: count", 2, removed.size());
        assert_true("removeStale: doc-b kept", Files.exists(dir.resolve("doc-b--33333333.md")));
    }

    // --- Manifest ---

    static void testManifestRoundtrip() {
        var manifest = new Manifest("abc123", "2026-08-06T00:00:00Z", "2.7.0",
            "/nix/store/xyz/bin/graphrag",
            List.of("src/a.typ", "src/b.tex"));
        var json = manifest.toJson();
        var parsed = Manifest.fromJson(json);
        assert_equals("manifest: commit", manifest.commit(), parsed.commit());
        assert_equals("manifest: timestamp", manifest.timestamp(), parsed.timestamp());
        assert_equals("manifest: version", manifest.graphragVersion(), parsed.graphragVersion());
        assert_equals("manifest: binary", manifest.graphragBinary(), parsed.graphragBinary());
        assert_equals("manifest: dirty", manifest.dirty(), parsed.dirty());

        var empty = new Manifest("", "", "", "", List.of());
        var parsedEmpty = Manifest.fromJson(empty.toJson());
        assert_equals("manifest: empty dirty", List.of(), parsedEmpty.dirty());
    }

    // --- Config ---

    static void testConfigParsing() {
        var yaml = """
            auto_update: true
            debounce_seconds: 600
            graphrag_binary: graphrag
            index_root: graph-index

            models:
              chat_model: openrouter/deepseek/deepseek-v4-flash
              chat_api_key_env: OPENROUTER_API_KEY
              embedding_provider: ollama
              embedding_model: nomic-embed-text
              embedding_api_base: http://localhost:11434

            projects:
              - name: ivp-book-series
                root: /home/nicky/code/ivp-book-series
                latex_root: src/legacy/latex
                exclude:
                  - result
                  - target
            """;
        var config = ExportConfig.parse(yaml, Path.of("/harness"), null);
        assert_equals("config: project name", "ivp-book-series", config.projectName());
        assert_equals("config: root", "/home/nicky/code/ivp-book-series",
            config.projectRoot().toString());
        assert_equals("config: chat model", "openrouter/deepseek/deepseek-v4-flash",
            config.models().chatModel());
        assert_equals("config: embedding provider", "ollama", config.models().embeddingProvider());
        assert_true("config: exclude parsed", config.excludeDirs().contains("result"));
        assert_true("config: exclude parsed 2", config.excludeDirs().contains("target"));
        assert_equals("config: debounce", 600, config.debounceSeconds());
    }

    static void testDocName() {
        assert_equals("docName: volume", "volume-1",
            ExportCli.docName("src/main/typst/volume-1/part1/ch01/x.typ"));
        assert_equals("docName: legacy volume", "volume-1",
            ExportCli.docName("src/legacy/latex/volume-1/part1/x.tex"));
    }

    static void testExclusion() {
        assert_true("exclude: result dir",
            ExportCli.isExcluded("result/foo.typ", List.of("result", ".git")));
        assert_true("exclude: nested",
            ExportCli.isExcluded("src/result/foo.typ", List.of("result")));
        assert_true("exclude: not excluded",
            !ExportCli.isExcluded("src/main/typst/volume-1/x.typ", List.of("result", ".git")));
    }

    static void testProofLinking() {
        var labels = Set.of("thm:variation-equivalence", "def:driver");
        var file = Path.of("src/main/typst/volume-1/part1/ch05/claims/thm-variation-equivalence-proof.typ");
        var inferred = ExportCli.inferProvesLabel(file, labels);
        assert_equals("proof-link: inferred", "thm:variation-equivalence", inferred);

        var block = new SemanticBlock(Kind.PROOF, null, "Proof of X", "body", "f.typ", 1, List.of());
        var linked = ExportCli.linkProof(block, file, labels);
        assert_equals("proof-link: refs added", List.of("thm:variation-equivalence"), linked.refs());

        var withRefs = new SemanticBlock(Kind.PROOF, null, "Proof of X", "body", "f.typ", 1, List.of("def:driver"));
        var unchanged = ExportCli.linkProof(withRefs, file, labels);
        assert_equals("proof-link: existing refs kept", List.of("def:driver"), unchanged.refs());

        var noMatch = ExportCli.inferProvesLabel(Path.of("x/unknown-thing-proof.typ"), labels);
        assert_equals("proof-link: no match", null, noMatch);

        var theorem = new SemanticBlock(Kind.THEOREM, null, "T", "body", "f.typ", 1, List.of());
        assert_equals("proof-link: theorem untouched", theorem, ExportCli.linkProof(theorem, file, labels));
    }

    static void testProofMarkerVerb() {
        var block = new SemanticBlock(Kind.PROOF, null, "Proof", "body", "f.typ", 1, List.of("thm:x"));
        var doc = new ExportedDocument("id", "volume-1", "typst", "primary", block);
        var rendered = DocumentWriter.render(doc, List.of());
        assert_true("proof-marker: proves verb", rendered.contains("[PROOF proves: thm:x]"));

        var thm = new SemanticBlock(Kind.THEOREM, "thm:y", "T", "body", "f.typ", 1, List.of("def:z"));
        var doc2 = new ExportedDocument("id2", "volume-1", "typst", "primary", thm);
        assert_true("proof-marker: cites verb",
            DocumentWriter.render(doc2, List.of()).contains("[THEOREM cites: def:z]"));
    }

    public static void main(String[] args) throws Exception {
        testTypstTheoremWithClaim();
        testTypstProofWithStrategy();
        testTypstSimpleEnvWithLabel();
        testTypstProseAndHeadings();
        testTypstMultipleEnvsInOneFile();
        testTypstCommentStripping();
        testLatexTheoremSplit();
        testLatexSectionSplit();
        testLatexCommentStripping();
        testLatexMarkdownConversion();
        testDeduplication();
        testFrontmatterRendering();
        testDocIdAndSha();
        testRemoveStale();
        testManifestRoundtrip();
        testConfigParsing();
        testDocName();
        testExclusion();
        testProofLinking();
        testProofMarkerVerb();
        cleanup();

        System.out.println("ExportTests: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
