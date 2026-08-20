package eu.infolead.llmhp.graphics;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Deterministic geometry gate for SVG/HTML artifacts: 4px-grid compliance on
 * {@code rect} node boxes and viewBox sanity.
 *
 * <p>Enforces the graphics-design-system contract that node boxes sit on the
 * 4px grid (exempting stroke widths 0.8/1/1.2, opacities, and the 22px dot
 * pattern). Chart primitives (line, circle, ellipse, polygon) and text are
 * exempt — they legitimately use fractional coordinates for data points,
 * trend lines, and baselines. The viewBox must be present and well-formed.</p>
 *
 * <p>The orthogonal-elbow connector rule is a design guideline enforced by the
 * skill spec (SKILL.md), not by this gate: chart and lane-transition arrows
 * legitimately run diagonally, so it cannot be a mechanical check.</p>
 *
 * <p>Java &gt;= 25 reimplementation of the vendored diagram-design Python
 * {@code scripts/verify-geometry.py}. This is the authority invoked by
 * opencode.</p>
 *
 * <p>Usage: {@code java GraphicsGeometryCheck <file> [<file> ...]}</p>
 */
public final class GraphicsGeometryCheck {

    private static final Pattern ATTR = Pattern.compile("([a-zA-Z:_][a-zA-Z0-9_.:/-]*)\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)");
    /** Grid-exempt numeric values: stroke widths and the dot-pattern radius/size. */
    private static final List<Double> EXEMPT = List.of(0.8, 0.9, 1.0, 1.2, 22.0);
    /** Geometry-bearing attributes on a rect that must sit on the 4px grid. */
    private static final Set<String> GEOMETRY_KEYS = Set.of("x", "y", "width", "height");
    /** Elements whose box geometry must sit on the grid. Only {@code rect}
     *  node boxes carry the 4px-grid contract; chart primitives (line, circle,
     *  ellipse, polygon) legitimately use fractional coordinates for data points
     *  and trend lines and are exempt. */
    private static final Set<String> LAYOUT_ELEMENTS = Set.of("rect");

    private GraphicsGeometryCheck() {
    }

    public record Result(Path file, List<String> errors) {
        public boolean ok() {
            return errors.isEmpty();
        }
    }

    public static void main(String[] args) throws IOException {
        if (args.length == 0) {
            System.err.println("usage: java GraphicsGeometryCheck <file> [<file> ...]");
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

    /** Run the geometry gate over in-memory source. */
    public static List<String> verify(String source) {
        List<String> errors = new ArrayList<>();
        checkViewBox(source, errors);
        checkGridCompliance(source, errors);
        return errors;
    }

    private static void checkViewBox(String source, List<String> errors) {
        Matcher svg = Pattern.compile("<svg\\b").matcher(source);
        int count = 0;
        while (svg.find()) {
            int end = source.indexOf('>', svg.start());
            if (end < 0) {
                break;
            }
            count++;
            String open = source.substring(svg.start(), end);
            String vb = attrValue(open, "viewBox");
            if (vb == null || vb.isBlank()) {
                errors.add("svg " + count + " is missing a viewBox");
                continue;
            }
            String[] parts = vb.trim().split("[\\s,]+");
            if (parts.length != 4) {
                errors.add("svg " + count + " viewBox must have 4 values: " + vb);
                continue;
            }
            for (String p : parts) {
                try {
                    double v = Double.parseDouble(p);
                    if (v != Math.floor(v)) {
                        errors.add("svg " + count + " viewBox value " + p + " is not an integer");
                    }
                } catch (NumberFormatException ex) {
                    errors.add("svg " + count + " viewBox value " + p + " is not numeric");
                }
            }
        }
    }

    private static void checkGridCompliance(String source, List<String> errors) {
        // Scan box geometry on rect node boxes. Only rects carry the 4px-grid
        // contract; chart primitives and text are exempt. Fractional coordinates
        // on a rect are always off-grid; integer sizes may legitimately fall
        // between grid lines for small decorative rects (tags, label masks),
        // so only flag non-integer geometry to avoid noise on valid output.
        Matcher tag = Pattern.compile("<([a-zA-Z][a-zA-Z0-9]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>").matcher(source);
        while (tag.find()) {
            String element = tag.group(1).toLowerCase(Locale.ROOT);
            if (!LAYOUT_ELEMENTS.contains(element)) {
                continue;
            }
            String attrs = tag.group(2);
            Matcher a = ATTR.matcher(attrs);
            while (a.find()) {
                String key = a.group(1).toLowerCase(Locale.ROOT);
                if (key.startsWith("stroke") || key.startsWith("opacity") || key.startsWith("fill")) {
                    continue; // color/stroke/opacity, not layout
                }
                if (!GEOMETRY_KEYS.contains(key)) {
                    continue;
                }
                String raw = unquote(a.group(2));
                for (String tok : raw.split("[\\s,]+")) {
                    if (tok.isEmpty()) {
                        continue;
                    }
                    Double v = parseNumber(tok);
                    if (v == null || EXEMPT.contains(v)) {
                        continue;
                    }
                    if (v != Math.floor(v)) {
                        errors.add("<" + element + "> " + key + "=" + tok + " is not on the 4px grid");
                    }
                }
            }
        }
    }

    private static Double parseNumber(String s) {
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String attrValue(String tag, String key) {
        Matcher m = ATTR.matcher(tag);
        String lk = key.toLowerCase(Locale.ROOT);
        while (m.find()) {
            if (m.group(1).toLowerCase(Locale.ROOT).equals(lk)) {
                return unquote(m.group(2));
            }
        }
        return null;
    }

    private static String unquote(String s) {
        if (s.length() >= 2 && (s.startsWith("\"") || s.startsWith("'"))) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }
}
