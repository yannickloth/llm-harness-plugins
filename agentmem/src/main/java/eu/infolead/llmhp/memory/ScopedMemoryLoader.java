package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;

public final class ScopedMemoryLoader {

    public static void resolve(Path projectRoot, Path cwd) throws IOException {
        var rootMemDir = projectRoot.resolve(".agentmem");
        System.out.printf("ROOT=%s\n", rootMemDir);

        var found = false;
        var current = cwd;
        while (current.startsWith(projectRoot)) {
            var memFile = current.resolve("MEMORY.md");
            if (Files.exists(memFile)) {
                System.out.printf("SCOPED=%s\n", memFile);
                found = true;
            }
            if (current.equals(projectRoot)) break;
            current = current.getParent();
        }
        if (!found) System.out.println("SCOPED=NONE");
    }

    public static String loadScopedIndex(Path cwd, Path projectRoot) throws IOException {
        var sb = new StringBuilder();
        var current = cwd;
        while (current.startsWith(projectRoot)) {
            var memFile = current.resolve("MEMORY.md");
            if (Files.exists(memFile)) {
                sb.append("--- scope: ").append(projectRoot.relativize(current)).append(" ---\n");
                sb.append(Files.readString(memFile)).append("\n");
            }
            if (current.equals(projectRoot)) break;
            current = current.getParent();
        }
        return sb.toString();
    }
}
