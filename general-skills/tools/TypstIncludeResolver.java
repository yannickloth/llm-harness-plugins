import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.*;

/**
 * TypstIncludeResolver - Recursively resolve all .typ files transitively included
 * by a root document.
 *
 * Walks #include and #import directives, resolving relative paths against the
 * including file's directory. Handles ../ segments. Skips files already visited
 * (prevents cycles). Reports the full transitive set of .typ files reachable
 * from the root.
 *
 * Usage: java TypstIncludeResolver.java <root.typ>
 * Output: one absolute .typ path per line.
 */
public class TypstIncludeResolver {

    // Matches #include "path" or #import "path" (path in double quotes).
    private static final Pattern INCLUDE = Pattern.compile(
        "#(?:include|import)\\s+\"([^\"]+)\""
    );

    private final Set<Path> visited = new LinkedHashSet<>();
    private final List<Path> order = new ArrayList<>();

    public List<Path> resolve(Path root) throws IOException {
        walk(root);
        return order;
    }

    private void walk(Path file) throws IOException {
        Path abs = file.toAbsolutePath().normalize();
        if (!Files.exists(abs)) return;
        if (!visited.add(abs)) return; // cycle guard
        order.add(abs);

        String content = Files.readString(abs);
        Matcher m = INCLUDE.matcher(content);
        while (m.find()) {
            Path inc = abs.getParent().resolve(m.group(1)).normalize();
            // Only follow .typ files (skip .bib, .yaml, etc.)
            if (inc.toString().endsWith(".typ")) {
                walk(inc);
            }
        }
    }

    public static void main(String[] args) throws IOException {
        if (args.length < 1) {
            System.err.println("Usage: java TypstIncludeResolver.java <root.typ>");
            System.exit(1);
        }
        TypstIncludeResolver r = new TypstIncludeResolver();
        List<Path> files = r.resolve(Path.of(args[0]));
        for (Path p : files) {
            System.out.println(p);
        }
        System.err.println("Resolved " + files.size() + " .typ files");
    }
}
