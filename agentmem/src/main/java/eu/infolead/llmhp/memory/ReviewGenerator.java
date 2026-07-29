package eu.infolead.llmhp.memory;

import eu.infolead.llmhp.memory.types.FrontmatterParser;

import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

public final class ReviewGenerator {

    public static void generate(Path memDir) throws IOException {
        var newOrChanged = new ArrayList<Path>();
        var weekAgo = Instant.now().minus(Duration.ofDays(7));

        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .filter(f -> { try { return Files.getLastModifiedTime(f).toInstant().isAfter(weekAgo); } catch (IOException e) { return false; } })
                 .forEach(newOrChanged::add);
        }

        if (newOrChanged.isEmpty()) {
            System.out.println("No new/changed memories this week.");
            return;
        }

        var sb = new StringBuilder();
        sb.append("# Weekly Memory Review — ").append(LocalDate.now()).append("\n\n");
        sb.append("## New/Changed (%d files)\n\n".formatted(newOrChanged.size()));

        var needsReview = 0;
        for (var f : newOrChanged) {
            try {
                var fm = FrontmatterParser.parse(Files.readString(f));
                var conf = fm.getOrDefault("confidence", "medium");
                var name = f.getFileName().toString();
                var desc = fm.getOrDefault("description", "");
                sb.append("- [ ] %s (`%s`)".formatted(desc, name));
                if (!conf.equals("medium")) sb.append(", confidence: %s".formatted(conf));
                sb.append("\n");
                if (conf.equals("speculative") || conf.equals("low")) needsReview++;
            } catch (IOException ignored) {}
        }

        if (needsReview > 0)
            sb.append("\n## Needs Attention\n\n%d memories flagged for review.\n".formatted(needsReview));

        sb.append("\n## Actions\n\n- Respond: Keep / Remove <name> / <name> is wrong because...\n- Or run `/skip-review`\n");

        Files.writeString(memDir.resolve("REVIEW.md"), sb.toString());
        System.out.println(sb.toString());
    }
}
