package eu.infolead.llmhp.graphics;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Deterministic gate for a generated diagram/HTML/SVG artifact.
 *
 * <p>Checks the accessible-SVG contract, single-file safety rules (no remote
 * assets beyond the approved Google Fonts stylesheet, no executable
 * attributes, no disallowed embedding elements), and that at least one
 * accessible SVG is present. The motion contract is out of scope here; see
 * {@link GraphicsMotionCheck}.</p>
 *
 * <p>This is the Java &gt;= 25 reimplementation of the vendored
 * diagram-design Python {@code scripts/self_check.py}, and is the authority
 * invoked by opencode.</p>
 *
 * <p>Usage: {@code java GraphicsSvgCheck <file> [<file> ...]}</p>
 */
public final class GraphicsSvgCheck {

    private static final Pattern SVG_OPEN = Pattern.compile("<svg\\b");
    private static final Pattern TAG = Pattern.compile("<(/?)([a-zA-Z0-9]+)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>");
    private static final Pattern ATTR = Pattern.compile("([a-zA-Z_:][a-zA-Z0-9_.:/-]*)\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)");

    /** Reference-bearing attributes, as in the Python self_check. */
    private static final List<String> REFERENCE_ATTRS = List.of(
            "src", "href", "xlink:href", "poster", "srcset", "action", "formaction");
    /** Elements that embed external content and are banned in single-file output. */
    private static final List<String> EMBED_TAGS = List.of("base", "embed", "object", "iframe");

    private GraphicsSvgCheck() {
    }

    /** Result of running the gate over one file. */
    public record Result(Path file, List<String> errors) {
        public boolean ok() {
            return errors.isEmpty();
        }
    }

    public static void main(String[] args) throws IOException {
        if (args.length == 0) {
            System.err.println("usage: java GraphicsSvgCheck <file> [<file> ...]");
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

    /** Run the full gate over a file. */
    public static Result verify(Path file) throws IOException {
        String source;
        try {
            source = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return new Result(file, List.of(e.getMessage() == null ? e.toString() : e.getMessage()));
        }
        return new Result(file, verify(source));
    }

    /** Run the full gate over in-memory source. */
    public static List<String> verify(String source) {
        List<String> errors = new ArrayList<>();
        boolean sawAccessibleSvg = false;

        // Lightweight scan: collect tags and attributes in one pass.
        Matcher tagMatcher = TAG.matcher(source);
        while (tagMatcher.find()) {
            boolean closing = !tagMatcher.group(1).isEmpty();
            String tag = tagMatcher.group(2).toLowerCase();
            String attrsBlock = tagMatcher.group(3);
            List<String[]> attrs = ATTR.matcher(attrsBlock).results()
                    .map(m -> new String[] { m.group(1).toLowerCase(), unquote(m.group(2)) })
                    .toList();

            if (!closing && EMBED_TAGS.contains(tag)) {
                errors.add("<" + tag + "> is not allowed in a diagram file");
            }
            for (String[] a : attrs) {
                String key = a[0];
                String value = a[1];
                if (key.startsWith("on")) {
                    errors.add("executable attribute " + key + " on <" + tag + ">");
                }
                if (key.equals("srcdoc")) {
                    errors.add("srcdoc attribute on <" + tag + ">");
                }
                if (REFERENCE_ATTRS.contains(key)) {
                    String rel = getAttr(attrs, "rel");
                    String err = referenceError(tag, rel, value);
                    if (err != null) {
                        errors.add(err);
                    }
                }
            }

            if (!closing && tag.equals("svg")) {
                boolean ariaHidden = "true".equalsIgnoreCase(getAttr(attrs, "aria-hidden"));
                if (!ariaHidden) {
                    sawAccessibleSvg = true;
                }
            }
        }

        if (!sawAccessibleSvg) {
            errors.add("diagram file needs at least one accessible (non-aria-hidden) SVG");
        }

        // The title/desc/script/style checks need structure; run a focused structural pass.
        checkSvgStructure(source, errors);
        checkScripts(source, errors);
        return errors;
    }

    /** Focused structural pass for title-first, ids, aria-labelledby ordering. */
    private static void checkSvgStructure(String source, List<String> errors) {
        Matcher svgMatcher = SVG_OPEN.matcher(source);
        int index = 0;
        while (svgMatcher.find()) {
            int svgStart = svgMatcher.start();
            int svgEnd = matchingClose(source, svgStart);
            if (svgEnd < 0) {
                errors.add("unclosed <svg> element");
                break;
            }
            String body = source.substring(svgStart, svgEnd);
            index++;
            String openTag = body.substring(0, body.indexOf('>') + 1);
            String role = attrValue(openTag, "role");
            String ariaHidden = attrValue(openTag, "aria-hidden");
            if ("true".equalsIgnoreCase(ariaHidden)) {
                continue;
            }

            int afterOpen = openTag.length();
            // First child must be <title>.
            Matcher first = TAG.matcher(body.substring(afterOpen));
            if (!first.find()) {
                errors.add("svg " + index + " has no content");
                continue;
            }
            String firstTag = first.group(2).toLowerCase();
            if (!firstTag.equals("title")) {
                errors.add("svg " + index + " title must be its first child");
            }

            String titleId = firstTag.equals("title") ? attrValue(first.group(0), "id") : "";
            String titleText = textBetween(body, afterOpen, "title");
            String descText = textBetween(body, afterOpen, "desc");
            String descId = attrOfTag(body, afterOpen, "desc", "id");

            if (titleText.isBlank() || descText.isBlank()) {
                errors.add("svg " + index + " needs non-empty title and desc");
            }
            if (titleId.isBlank() || titleId.equals("title") || descId.isBlank() || descId.equals("desc")) {
                errors.add("svg " + index + " title/desc IDs must be diagram-prefixed, never bare");
            }
            if (role == null || !role.equals("img")) {
                errors.add("svg " + index + " needs role=img");
            }
            String labelledBy = attrValue(openTag, "aria-labelledby");
            if (labelledBy == null || !labelledBy.strip().equals((titleId + " " + descId).strip())) {
                errors.add("svg " + index + " aria-labelledby must name title then desc");
            }
            svgMatcher = SVG_OPEN.matcher(source).region(Math.min(svgEnd + 1, source.length()), source.length());
        }
    }

    /** Find the index of the closing {@code </svg>} balancing the open at {@code start}. */
    private static int matchingClose(String source, int start) {
        int depth = 0;
        Matcher m = TAG.matcher(source.substring(start));
        while (m.find()) {
            boolean closing = !m.group(1).isEmpty();
            String tag = m.group(2).toLowerCase();
            if (tag.equals("svg")) {
                if (closing) {
                    depth--;
                    if (depth == 0) {
                        return start + m.end();
                    }
                } else {
                    depth++;
                }
            }
        }
        return -1;
    }

    /** Extract the text content of the first {@code <name>} element in {@code from}. */
    private static String textBetween(String s, int from, String name) {
        Matcher open = Pattern.compile("<" + name + "\\b").matcher(s);
        if (!open.find(from)) {
            return "";
        }
        int contentStart = s.indexOf('>', open.start()) + 1;
        Matcher close = Pattern.compile("</" + name + ">").matcher(s);
        if (!close.find(contentStart)) {
            return "";
        }
        return s.substring(contentStart, close.start()).strip();
    }

    /** Extract the value of attribute {@code attr} from the first {@code <name>} tag at/after {@code from}. */
    private static String attrOfTag(String s, int from, String name, String attr) {
        Matcher open = Pattern.compile("<" + name + "\\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>").matcher(s);
        if (!open.find(from)) {
            return "";
        }
        return attrValue(open.group(0), attr);
    }

    private static String getAttr(List<String[]> attrs, String key) {
        for (String[] a : attrs) {
            if (a[0].equals(key)) {
                return a[1];
            }
        }
        return null;
    }

    private static String attrValue(String tag, String key) {
        Matcher m = ATTR.matcher(tag);
        while (m.find()) {
            if (m.group(1).toLowerCase().equals(key)) {
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

    /** Single-file safety check on a remote/executable reference. */
    private static String referenceError(String tag, String rel, String value) {
        String stripped = value.strip();
        String lowered = stripped.toLowerCase();
        if (stripped.isEmpty() || stripped.startsWith("#")) {
            return null;
        }
        if (lowered.startsWith("javascript:") || lowered.startsWith("data:text/html")) {
            return "executable URL on <" + tag + ">: " + truncate(stripped);
        }
        boolean remote = lowered.startsWith("http://") || lowered.startsWith("https://")
                || lowered.startsWith("//")
                || (containsColonBeforeSlash(stripped) && !lowered.startsWith("data:"));
        if (!remote) {
            if (lowered.startsWith("data:") && !lowered.startsWith("data:image/")) {
                return "non-image data URL on <" + tag + ">: " + truncate(stripped);
            }
            return null;
        }
        if (tag.equals("link") && rel != null && rel.toLowerCase().contains("stylesheet")) {
            if (isApprovedGoogleFontsStylesheet(stripped)) {
                return null;
            }
            return "remote stylesheet is not the approved Google Fonts /css2 URL: " + truncate(stripped);
        }
        return "remote reference on <" + tag + ">: " + truncate(stripped);
    }

    private static boolean containsColonBeforeSlash(String s) {
        int colon = s.indexOf(':');
        int slash = s.indexOf('/');
        return colon >= 0 && (slash < 0 || colon < slash);
    }

    private static boolean isApprovedGoogleFontsStylesheet(String value) {
        try {
            var uri = java.net.URI.create(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            int port = uri.getPort();
            String path = uri.getPath();
            return "https".equals(scheme)
                    && host != null && host.equalsIgnoreCase("fonts.googleapis.com")
                    && port == -1
                    && "/css2".equals(path)
                    && uri.getRawFragment() == null;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static void checkScripts(String source, List<String> errors) {
        int count = countOccurrences(source, "<script");
        if (count > 1) {
            errors.add("at most one script is allowed; found " + count);
        }
    }

    private static int countOccurrences(String s, String sub) {
        int n = 0;
        int i = 0;
        while ((i = s.indexOf(sub, i)) >= 0) {
            n++;
            i += sub.length();
        }
        return n;
    }

    private static String truncate(String s) {
        return s.length() <= 80 ? s : s.substring(0, 80);
    }
}
