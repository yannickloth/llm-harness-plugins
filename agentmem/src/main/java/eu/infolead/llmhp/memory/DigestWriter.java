package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

public final class DigestWriter {

    public static void writeEpisode(Path memDir, String episodeName, String sourcesCsv) throws IOException {
        var sources = sourcesCsv.isEmpty() ? List.<String>of() : List.of(sourcesCsv.split(",\\s*"));
        var name = "episode_" + episodeName.replaceAll("[^a-zA-Z0-9_]", "_").toLowerCase();
        var target = memDir.resolve(name + ".md");

        var body = new StringBuilder();
        body.append("## Episode: %s\n\n".formatted(episodeName));
        body.append("**Trigger:** (extracted from sources during dream phase)\n\n");
        body.append("**What happened:**\n");
        for (var src : sources) {
            var file = memDir.resolve(src);
            if (Files.exists(file)) {
                var firstLine = Files.readString(file).lines()
                    .skip(3).filter(l -> !l.isBlank()).findFirst().orElse("");
                body.append("- ").append(firstLine).append("\n");
            }
        }
        body.append("\n**Resolution:** (dreamer fills from cross-references)\n");

        var frontmatter = """
            ---
            name: %s
            description: Full narrative: %s
            type: project
            subtype: episode
            sources: %s
            timeline_start: %s
            timeline_end: %s
            ---
            %s
            """.formatted(name, episodeName, String.join(", ", sources),
                Instant.now().minus(Duration.ofDays(7)).toString().substring(0, 10),
                Instant.now().toString().substring(0, 10), body.toString());

        Files.writeString(target, frontmatter);
        System.out.println("EPISODE_WRITTEN " + name);
    }
}
