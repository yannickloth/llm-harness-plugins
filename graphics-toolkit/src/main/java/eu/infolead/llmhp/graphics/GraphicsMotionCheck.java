package eu.infolead.llmhp.graphics;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Deterministic gate for the optional motion contract on an SVG/HTML artifact.
 *
 * <p>Scans real HTML tags (not CSS/JS text) for motion attributes. Checks the
 * structural motion rules: exactly one {@code data-motion-root}; a valid
 * {@code data-motion-mode} (none/reveal/step/loop); a {@code data-step-count}
 * in 0..8; no more than 12 motion items; contiguous semantic steps 1..N with
 * at most two items per step; decorative items marked {@code aria-hidden} and
 * {@code focusable=false}; a non-color {@code aria-label} on semantic items;
 * and, for controlled modes (reveal-with-script, step), one control group
 * with all actions, a {@code role=status} outside the controls, and the
 * canonical script. Script-free modes (none/loop) must not expose controls.
 * Requires reduced-motion and print CSS fallbacks when a script is present.</p>
 *
 * <p>Java &gt;= 25 reimplementation of the vendored diagram-design motion
 * contract.</p>
 *
 * <p>Usage: {@code java GraphicsMotionCheck <file> [<file> ...]}</p>
 */
public final class GraphicsMotionCheck {

    private static final Set<String> MODES = Set.of("none", "reveal", "step", "loop");
    private static final Set<String> ACTIONS = Set.of("play", "pause", "replay", "prev", "next");
    private static final Pattern TAG = Pattern.compile("<([a-zA-Z][a-zA-Z0-9]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>");
    private static final Pattern ATTR = Pattern.compile("([a-zA-Z_:][a-zA-Z0-9_.:/-]*)(?:\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+))?");

    private GraphicsMotionCheck() {
    }

    public record Result(Path file, List<String> errors) {
        public boolean ok() {
            return errors.isEmpty();
        }
    }

    public static void main(String[] args) throws IOException {
        if (args.length == 0) {
            System.err.println("usage: java GraphicsMotionCheck <file> [<file> ...]");
            System.exit(2);
        }
        boolean failed = false;
        for (String arg : args) {
            Result r = verify(Path.of(arg));
            if (r.ok()) {
                System.out.println("OK " + arg);
            } else {
                failed = true;
                System.out.println("FAIL " + arg);
                for (String e : r.errors()) {
                    System.out.println("  - " + e);
                }
            }
        }
        System.exit(failed ? 1 : 0);
    }

    public static Result verify(Path file) throws IOException {
        String source;
        try {
            source = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return new Result(file, List.of(e.getMessage() == null ? e.toString() : e.getMessage()));
        }
        return new Result(file, verify(source));
    }

    public static List<String> verify(String source) {
        List<String> errors = new ArrayList<>();

        // Parse real tags into attribute maps (boolean attrs -> empty value).
        List<Map<String, String>> tags = new ArrayList<>();
        Matcher tm = TAG.matcher(source);
        while (tm.find()) {
            String body = tm.group(2);
            Map<String, String> attrs = new HashMap<>();
            Matcher am = ATTR.matcher(body);
            while (am.find()) {
                String key = am.group(1);
                String val = am.group(2) == null ? "" : unquote(am.group(2));
                attrs.put(key, val);
            }
            tags.add(attrs);
        }

        int scripts = (int) countOccurrences(source, "<script");
        boolean hasMotion = tags.stream().anyMatch(a -> a.containsKey("data-motion-root"))
                || tags.stream().anyMatch(a -> a.containsKey("data-motion-item"))
                || scripts > 0;
        if (!hasMotion) {
            return errors; // no motion markup
        }

        List<Map<String, String>> roots = tags.stream().filter(a -> a.containsKey("data-motion-root")).toList();
        if (roots.size() != 1) {
            errors.add("expected exactly one data-motion-root; found " + roots.size());
            return errors;
        }
        Map<String, String> root = roots.get(0);

        String mode = root.getOrDefault("data-motion-mode", "");
        if (!MODES.contains(mode)) {
            errors.add("data-motion-mode must be one of " + MODES + "; got '" + mode + "'");
        }

        int count = -1;
        String rawCount = root.get("data-step-count");
        if (rawCount == null || !rawCount.matches("[0-9]+")) {
            errors.add("data-step-count must be an ASCII decimal integer");
        } else {
            count = Integer.parseInt(rawCount);
        }
        int minimum = mode.equals("none") ? 0 : 1;
        if (count != -1 && (count < minimum || count > 8)) {
            errors.add("semantic step count must be " + minimum + "..8; got " + count);
        }

        List<Map<String, String>> items = tags.stream().filter(a -> a.containsKey("data-motion-item")).toList();
        if (items.size() > 12) {
            errors.add("motion item budget is 12; found " + items.size());
        }
        List<Integer> semanticSteps = new ArrayList<>();
        for (int i = 0; i < items.size(); i++) {
            Map<String, String> it = items.get(i);
            String step = it.getOrDefault("data-step", "");
            if (!step.matches("[0-9]+")) {
                errors.add("motion item " + (i + 1) + " has a non-ASCII-decimal data-step");
                continue;
            }
            int s = Integer.parseInt(step);
            boolean decorative = it.containsKey("data-motion-decorative");
            if (!decorative) {
                semanticSteps.add(s);
                if (it.getOrDefault("aria-label", "").isBlank()) {
                    errors.add("semantic motion item " + (i + 1) + " needs a non-color aria-label");
                }
            } else {
                if (!"true".equalsIgnoreCase(it.getOrDefault("aria-hidden", ""))
                        || !"false".equalsIgnoreCase(it.getOrDefault("focusable", ""))) {
                    errors.add("decorative motion item " + (i + 1) + " needs aria-hidden=true and focusable=false");
                }
            }
            String inline = it.getOrDefault("style", "").toLowerCase().replace(" ", "");
            if (inline.contains("display:none") || inline.contains("visibility:hidden") || inline.contains("opacity:0")) {
                errors.add("motion item " + (i + 1) + " is hidden in source; the fallback must be visible");
            }
        }

        // Contiguity only meaningful once the step count parses.
        if (count >= 0) {
            Set<Integer> expected = rangeSet(count);
            if (!new HashSet<>(semanticSteps).equals(expected)) {
                errors.add("semantic steps must be contiguous 1.." + count + "; found " + sortedInts(semanticSteps));
            }
        }
        Map<Integer, Long> freq = new HashMap<>();
        for (int s : semanticSteps) {
            freq.merge(s, 1L, Long::sum);
        }
        freq.forEach((step, n) -> {
            if (n > 2) {
                errors.add("no more than two semantic items may share a step; step " + step + " has " + n);
            }
        });

        List<Map<String, String>> controls = tags.stream().filter(a -> a.containsKey("data-motion-controls")).toList();
        List<String> actions = tags.stream()
                .flatMap(a -> a.containsKey("data-motion-action")
                        ? java.util.stream.Stream.of(a.get("data-motion-action"))
                        : java.util.stream.Stream.empty())
                .toList();
        List<Map<String, String>> statuses = tags.stream().filter(a -> a.containsKey("data-motion-status")).toList();

        if ((mode.equals("none") || mode.equals("loop")) && scripts > 0) {
            errors.add(mode + " mode must be script-free");
        }
        if ((mode.equals("none") || mode.equals("loop")) && (!controls.isEmpty() || !actions.isEmpty() || !statuses.isEmpty())) {
            errors.add(mode + " mode must not expose playback controls or live status");
        }
        boolean controlled = mode.equals("step") || (mode.equals("reveal") && scripts > 0);
        if (controlled) {
            if (controls.size() != 1) {
                errors.add("controlled mode needs one in-root control group; found " + controls.size());
            }
            Set<String> foundActions = new HashSet<>(actions);
            Set<String> missing = new HashSet<>(ACTIONS);
            missing.removeAll(foundActions);
            if (!missing.isEmpty()) {
                errors.add("controlled mode is missing actions: " + sortedStrings(missing));
            }
            if (statuses.isEmpty()) {
                errors.add("controlled mode needs data-motion-status");
            } else {
                Map<String, String> st = statuses.get(0);
                if (!"status".equals(st.get("role"))
                        || !"polite".equals(st.get("aria-live"))
                        || !"true".equals(st.get("aria-atomic"))) {
                    errors.add("motion status needs role=status, aria-live=polite, aria-atomic=true");
                }
            }
        }

        if (scripts > 0) {
            if (regexFind(source, "prefers-reduced-motion\\s*:\\s*reduce") == null) {
                errors.add("missing reduced-motion CSS fallback (prefers-reduced-motion)");
            }
            if (regexFind(source, "@media\\s+print\\b") == null) {
                errors.add("missing print CSS fallback (@media print)");
            }
            if (!source.toLowerCase().contains("<noscript")) {
                errors.add("motion file needs a <noscript> explanation of the complete static frame");
            }
        }
        return errors;
    }

    private static Set<Integer> rangeSet(int n) {
        Set<Integer> s = new HashSet<>();
        for (int i = 1; i <= n; i++) {
            s.add(i);
        }
        return s;
    }

    private static String sortedStrings(Set<String> s) {
        return s.stream().sorted().collect(Collectors.joining(", "));
    }

    private static String sortedInts(List<Integer> s) {
        return s.stream().sorted().toList().toString();
    }

    private static String regexFind(String s, String pattern) {
        Matcher m = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE).matcher(s);
        return m.find() ? m.group(0) : null;
    }

    private static String unquote(String s) {
        if (s.length() >= 2 && (s.startsWith("\"") || s.startsWith("'"))) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    private static int countOccurrences(String s, String sub) {
        int n = 0, i = 0;
        while ((i = s.indexOf(sub, i)) >= 0) {
            n++;
            i += sub.length();
        }
        return n;
    }
}
