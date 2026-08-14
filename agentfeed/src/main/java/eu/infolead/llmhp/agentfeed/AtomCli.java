package eu.infolead.llmhp.agentfeed;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/**
 * CLI entry point for Atom feed generation.
 *
 * Usage:
 *   AtomCli --ledger <path> --out <dir>
 */
public final class AtomCli {

    public static void main(String[] args) throws IOException {
        var ledgerPath = arg(args, "--ledger").orElseThrow(() -> new IllegalArgumentException("--ledger required"));
        var outDir = arg(args, "--out").orElse(Path.of(".").toString());

        var entries = AtomFeed.readLedger(Path.of(ledgerPath));
        var sorted = AtomFeed.sorted(entries);
        var project = AtomFeed.projectName(ledgerPath);
        AtomFeed.generate(Path.of(outDir), project, sorted);

        System.out.println("agentfeed: wrote " + (1 + agentCount(sorted)) + " feeds to " + outDir);
    }

    private static long agentCount(List<AtomFeed.Entry> entries) {
        return entries.stream().map(AtomFeed.Entry::agent).distinct().count();
    }

    private static Optional<String> arg(String[] args, String name) {
        for (int i = 0; i < args.length - 1; i++) {
            if (args[i].equals(name)) return Optional.of(args[i + 1]);
        }
        return Optional.empty();
    }
}
