import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * AppendOnlyMergeDriver — a git merge driver for the agentfeed coordination ledger.
 *
 * The ledger (agentfeed/ledger.jsonl) is an append-only JSONL stream where each line
 * carries a globally-unique id (`host:seq`). Cross-host coordination works by git
 * merging two independently-appended copies. A normal 3-way merge would raise a
 * conflict whenever both sides appended different lines; this driver instead unions
 * the entries from all three inputs (base, current, other), deduplicating by line,
 * so the merge always succeeds and never collides — matching the design's
 * "append-only, no conflicts" claim.
 *
 * Invoked by git via `.gitattributes` + `git config merge.agentfeed-ledger.driver`:
 *     git-appendonly-merge %O %A %B
 *
 * Contract (see gitattributes(5)): produce the merged result in %A and exit 0 on
 * success; exit non-zero to fall back to conflict markers.
 */
public final class AppendOnlyMergeDriver {
    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: AppendOnlyMergeDriver <ancestor> <current> <other>");
            System.exit(2);
        }
        Path base = Path.of(args[0]);   // %O — merge base
        Path current = Path.of(args[1]); // %A — our side (write result here)
        Path other = Path.of(args[2]);   // %B — their side

        // Union of all entries across the three versions, preserving first-seen order
        // and deduplicating by exact line (identical id = host:seq appear on both sides).
        LinkedHashSet<String> merged = new LinkedHashSet<>();
        mergeLines(base, merged);
        mergeLines(current, merged);
        mergeLines(other, merged);

        StringBuilder sb = new StringBuilder();
        for (String line : merged) {
            if (line.isBlank()) continue;
            sb.append(line).append('\n');
        }

        Files.writeString(current, sb.toString());
        System.exit(0);
    }

    private static void mergeLines(Path file, LinkedHashSet<String> into) throws IOException {
        if (!Files.exists(file)) return;
        List<String> lines = Files.readAllLines(file);
        into.addAll(lines);
    }
}
