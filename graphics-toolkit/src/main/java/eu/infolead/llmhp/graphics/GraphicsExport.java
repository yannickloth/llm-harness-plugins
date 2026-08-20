package eu.infolead.llmhp.graphics;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Export a generated diagram HTML into a standalone SVG, and compute PNG
 * rasterization sizing from the SVG {@code viewBox} × a scale factor.
 *
 * <p>The diagram-only SVG is extracted from the first {@code <svg>} node of
 * the source HTML. Editorial wrappers (cards, header, footer) are dropped.
 * The exported SVG is standalone XML with {@code xmlns} and a merged Google
 * Fonts {@code @import} (XML-escaped {@code &amp;}).</p>
 *
 * <p>PNG rasterization requires a browser; this tool computes the exact
 * {@code viewBox}×scale dimensions and reports the Playwright invocation to
 * use. It never writes a PNG itself.</p>
 *
 * <p>Usage: {@code java GraphicsExport <src.html> [--out <svg-path>] [--scale N]}</p>
 */
public final class GraphicsExport {

    private static final Pattern SVG_BLOCK = Pattern.compile(
            "<svg\\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>(?<body>.*?)</svg>", Pattern.DOTALL);
    private static final String FONT_IMPORT =
            "@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&amp;family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500;600&amp;display=swap');";

    private GraphicsExport() {
    }

    public static void main(String[] args) throws IOException {
        if (args.length == 0 || args[0].equals("--help")) {
            System.err.println("usage: java GraphicsExport <src.html> [--out <svg-path>] [--scale N]");
            System.exit(args.length == 0 ? 2 : 0);
        }
        Path src = Path.of(args[0]);
        Path out = null;
        double scale = 2.0;
        for (int i = 1; i < args.length; i++) {
            switch (args[i]) {
                case "--out" -> {
                    if (++i >= args.length) {
                        System.err.println("--out requires a path argument");
                        System.exit(2);
                    }
                    out = Path.of(args[i]);
                }
                case "--scale" -> {
                    if (++i >= args.length) {
                        System.err.println("--scale requires a number argument");
                        System.exit(2);
                    }
                    try {
                        scale = Double.parseDouble(args[i]);
                    } catch (NumberFormatException e) {
                        System.err.println("invalid --scale value: " + args[i]);
                        System.exit(2);
                    }
                }
                default -> {
                    System.err.println("unknown argument: " + args[i]);
                    System.exit(2);
                }
            }
        }
        String html = Files.readString(src, StandardCharsets.UTF_8);
        String svg = extractSvg(html);
        if (svg == null) {
            System.err.println("no <svg> block found in " + src + " — not a diagram file");
            System.exit(1);
        }
        if (out == null) {
            String base = src.getFileName().toString();
            int dot = base.lastIndexOf('.');
            base = dot >= 0 ? base.substring(0, dot) : base;
            out = src.resolveSibling(base + ".svg");
        }
        Files.writeString(out, svg, StandardCharsets.UTF_8);
        System.out.println("wrote " + out);

        // Report PNG sizing.
        String vb = attrValue(svg, "viewBox");
        if (vb != null) {
            String[] p = vb.trim().split("[\\s,]+");
            if (p.length == 4) {
                int w = (int) Math.round(Double.parseDouble(p[2]) * scale);
                int h = (int) Math.round(Double.parseDouble(p[3]) * scale);
                System.out.println("PNG @ " + fmt(scale) + "x → " + w + "×" + h + " (viewBox " + vb + ")");
                System.out.println("Rasterize with Playwright: screenshot the <svg> bounding box, omit_background=True.");
            }
        }
    }

    /** Extract a standalone diagram SVG from HTML, or null if none. */
    public static String extractSvg(String html) {
        Matcher m = SVG_BLOCK.matcher(html);
        if (!m.find()) {
            return null;
        }
        String openAttrs = m.group(1);
        String body = m.group("body");
        String open = "<svg" + openAttrs + ">";
        if (!open.contains("xmlns=")) {
            open = open.replace("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"");
        }
        String svg = open + body + "</svg>";

        // Merge the Google Fonts @import into the svg's <defs> if present,
        // otherwise inject a fresh <defs> after the opening tag.
        String styleTag = "<style>" + FONT_IMPORT + "</style>";
        int defsIdx = svg.indexOf("<defs>");
        if (defsIdx >= 0) {
            // insert the style right after the <defs> open tag, before existing content
            int insertAt = defsIdx + "<defs>".length();
            svg = svg.substring(0, insertAt) + styleTag + svg.substring(insertAt);
        } else {
            int openEnd = svg.indexOf('>') + 1;
            svg = svg.substring(0, openEnd) + "<defs>" + styleTag + "</defs>" + svg.substring(openEnd);
        }
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + svg;
    }

    private static String attrValue(String svg, String key) {
        Matcher m = Pattern.compile(key + "\\s*=\\s*(\"[^\"]*\"|'[^']*')").matcher(svg);
        if (m.find()) {
            return unquote(m.group(1));
        }
        return null;
    }

    private static String unquote(String s) {
        if (s.length() >= 2 && (s.startsWith("\"") || s.startsWith("'"))) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    private static String fmt(double v) {
        if (v == Math.floor(v)) {
            return String.valueOf((long) v);
        }
        return String.valueOf(v);
    }
}
