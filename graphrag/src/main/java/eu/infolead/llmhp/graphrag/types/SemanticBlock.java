package eu.infolead.llmhp.graphrag.types;

import java.util.*;

public record SemanticBlock(
    Kind kind,
    String label,
    String name,
    String body,
    String file,
    int line,
    List<String> refs
) {

    public enum Kind {
        THEOREM("theorem"),
        PROPOSITION("proposition"),
        LEMMA("lemma"),
        COROLLARY("corollary"),
        CONJECTURE("conjecture"),
        DEFINITION("definition"),
        AXIOM("axiom"),
        PRINCIPLE("principle"),
        ASSUMPTION("assumption"),
        GUIDELINE("guideline"),
        CORRESPONDENCE("correspondence"),
        REMARK("remark"),
        OBSERVATION("observation"),
        EXAMPLE("example"),
        KEY_INSIGHT("key-insight"),
        COUNTEREXAMPLE("counterexample"),
        PROOF("proof"),
        SOLUTION("solution"),
        EXERCISE("exercise"),
        CONFUSION("common-confusion"),
        SECTION("section"),
        PROSE("prose");

        private final String envName;

        Kind(String envName) {
            this.envName = envName;
        }

        public String envName() {
            return envName;
        }
    }

    public boolean isFormal() {
        return kind != Kind.SECTION && kind != Kind.PROSE;
    }

    public String labelPrefix() {
        return switch (kind) {
            case THEOREM -> "thm";
            case PROPOSITION -> "prop";
            case LEMMA -> "lem";
            case COROLLARY -> "cor";
            case CONJECTURE -> "conj";
            case DEFINITION -> "def";
            case AXIOM -> "axm";
            case PRINCIPLE -> "principle";
            case ASSUMPTION -> "asm";
            case GUIDELINE -> "guide";
            case CORRESPONDENCE -> "corr";
            case REMARK -> "rem";
            case OBSERVATION -> "obs";
            case EXAMPLE -> "ex";
            case KEY_INSIGHT -> "ki";
            case COUNTEREXAMPLE -> "cex";
            case PROOF -> "proof";
            case SOLUTION -> "sol";
            case EXERCISE -> "ex";
            case CONFUSION -> "confusion";
            case SECTION -> "sec";
            case PROSE -> "prose";
        };
    }
}
