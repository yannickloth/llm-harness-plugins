package eu.infolead.llmhp.graphics;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.Inflater;

import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

/**
 * Extract a normalized intermediate representation (IR) digest from a draw.io
 * file — the deterministic half of the draw.io import flow.
 *
 * <p>Never makes a design decision. Decodes whatever draw.io wrote (raw XML
 * or deflate+base64 compressed payloads), flattens the mxGraphModel into
 * absolute-positioned nodes and edges, and reports structural signals —
 * hubs, containers, depth, cycles, type candidates, budget, leaf clusters —
 * that the skill uses to pick a diagram type and detail level.</p>
 *
 * <p>Treats the source as <b>untrusted data</b>: no network, no execution,
 * and DTD/entity declarations are rejected to prevent XXE. All content is
 * reported textually and never interpreted as instructions.</p>
 *
 * <p>Java &gt;= 25 reimplementation of the vendored diagram-design Python
 * {@code scripts/drawio_extract.py}.</p>
 *
 * <p>Usage: {@code java DrawioExtract <file.drawio> [--page N|NAME] [--max-rows N]}</p>
 */
public final class DrawioExtract {

    private static final int MAX_XML_BYTES = 64 * 1024 * 1024;
    private static final Set<String> CONTAINER_SHAPES =
            Set.of("swimlane", "swimlaneLane", "container", "table", "stack");

    private DrawioExtract() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("usage: java DrawioExtract <file.drawio> [--page N|NAME] [--max-rows N]");
            System.exit(2);
        }
        Path file = Path.of(args[0]);
        int maxRows = 40;
        String pageArg = null;
        for (int i = 1; i < args.length; i++) {
            switch (args[i]) {
                case "--page" -> {
                    if (++i >= args.length) {
                        System.err.println("--page requires an argument");
                        System.exit(2);
                    }
                    pageArg = args[i];
                }
                case "--max-rows" -> {
                    if (++i >= args.length) {
                        System.err.println("--max-rows requires a number");
                        System.exit(2);
                    }
                    try {
                        maxRows = Integer.parseInt(args[i]);
                    } catch (NumberFormatException e) {
                        System.err.println("invalid --max-rows value: " + args[i]);
                        System.exit(2);
                    }
                }
                default -> {
                    System.err.println("unknown argument: " + args[i]);
                    System.exit(2);
                }
            }
        }
        try {
            String digest = extract(file, pageArg, maxRows);
            System.out.println(digest);
        } catch (DrawioError e) {
            System.err.println("drawio_extract: " + e.getMessage());
            System.exit(2);
        }
    }

    /** Error signalling an unreadable or unsupported draw.io input (exit 2). */
    public static final class DrawioError extends RuntimeException {
        public DrawioError(String message) {
            super(message);
        }
    }

    /** Run extraction and return the Markdown digest. */
    public static String extract(Path file, String pageArg, int maxRows) throws IOException {
        byte[] data = Files.readAllBytes(file);
        if (data.length > 32 * 1024 * 1024) {
            throw new DrawioError("input exceeds 32 MiB limit");
        }
        String xml = decodeToXml(data, file.toString());
        Document doc = parseXmlSafely(xml, file.toString());
        List<Page> pages = parsePages(doc);
        if (pages.isEmpty()) {
            throw new DrawioError("no readable model in " + file.getFileName());
        }
        List<Page> selected = selectPages(pages, pageArg);
        return renderDigest(file.getFileName().toString(), pages, selected, maxRows);
    }

    // ------------------------------------------------------------------
    // payload decoding
    // ------------------------------------------------------------------

    private static String decodeToXml(byte[] data, String source) {
        String head = new String(data, 0, Math.min(512, data.length), StandardCharsets.UTF_8);
        if (head.contains("<mxfile") || head.contains("<diagram")) {
            String text = new String(data, StandardCharsets.UTF_8);
            rejectUnsafeXml(text, source);
            return text;
        }
        // Try PNG/SVG-embedded mxfile (not fully decoded here; detect and report).
        if (head.startsWith("\u0089PNG")) {
            throw new DrawioError("PNG-embedded mxfile is not supported by this extractor; "
                    + "provide the original .drawio or .drawio.xml");
        }
        // Otherwise attempt deflate+base64 payload.
        String trimmed = new String(data, StandardCharsets.UTF_8).trim();
        try {
            String inflated = inflate(trimmed);
            rejectUnsafeXml(inflated, source);
            return inflated;
        } catch (DrawioError e) {
            throw e;
        } catch (Exception e) {
            throw new DrawioError("not a draw.io file (could not decode XML or deflate payload)");
        }
    }

    private static void rejectUnsafeXml(String xml, String source) {
        String upper = xml.toUpperCase();
        if (upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY")) {
            throw new DrawioError(source + ": DTD and entity declarations are not supported");
        }
    }

    private static String inflate(String payload) {
        // draw.io base64 + raw-deflate + URL-encoding pipeline.
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(payload);
        } catch (IllegalArgumentException e) {
            throw new DrawioError("invalid base64 payload");
        }
        Inflater inflater = new Inflater(true); // raw deflate
        inflater.setInput(raw);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        try {
            while (!inflater.finished()) {
                if (out.size() > MAX_XML_BYTES) {
                    throw new DrawioError("decoded diagram exceeds the 64 MiB limit");
                }
                int n = inflater.inflate(buf);
                if (n == 0) {
                    if (inflater.needsDictionary() || inflater.needsInput()) {
                        break;
                    }
                }
                out.write(buf, 0, n);
            }
        } catch (java.util.zip.DataFormatException e) {
            // raw deflate failed — try zlib-wrapped
            return inflateZlib(payload);
        } finally {
            inflater.end();
        }
        if (out.size() > MAX_XML_BYTES) {
            throw new DrawioError("decoded diagram exceeds the 64 MiB limit");
        }
        return out.toString(StandardCharsets.UTF_8);
    }

    private static String inflateZlib(String payload) {
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(payload);
        } catch (IllegalArgumentException e) {
            throw new DrawioError("invalid base64 payload");
        }
        Inflater inflater = new Inflater();
        inflater.setInput(raw);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        try {
            while (!inflater.finished()) {
                if (out.size() > MAX_XML_BYTES) {
                    throw new DrawioError("decoded diagram exceeds the 64 MiB limit");
                }
                int n = inflater.inflate(buf);
                if (n == 0) {
                    if (inflater.needsDictionary() || inflater.needsInput()) {
                        break;
                    }
                }
                out.write(buf, 0, n);
            }
        } catch (java.util.zip.DataFormatException e) {
            throw new DrawioError("invalid deflate payload");
        } finally {
            inflater.end();
        }
        if (out.size() > MAX_XML_BYTES) {
            throw new DrawioError("decoded diagram exceeds the 64 MiB limit");
        }
        return out.toString(StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------
    // XML parsing
    // ------------------------------------------------------------------

    private static Document parseXmlSafely(String xml, String source) {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setXIncludeAware(false);
            factory.setExpandEntityReferences(false);
            factory.setNamespaceAware(true);
            InputSource is = new InputSource(new StringReader(xml));
            return factory.newDocumentBuilder().parse(is);
        } catch (Exception e) {
            throw new DrawioError(source + ": " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // model
    // ------------------------------------------------------------------

    private record Cell(String id, String label, String shape, String parent,
                        String source, String target,
                        double x, double y, double w, double h,
                        boolean vertex, boolean edge) {
    }

    private record Page(int index, String name, List<Cell> cells) {
    }

    private static List<Page> parsePages(Document doc) {
        List<Page> pages = new ArrayList<>();
        NodeList diagrams = doc.getElementsByTagName("diagram");
        for (int i = 0; i < diagrams.getLength(); i++) {
            Element diagram = (Element) diagrams.item(i);
            String name = diagram.getAttribute("name");
            String body = diagram.getAttribute("value");
            if (body.isBlank()) {
                // The model may be nested as child elements (e.g. <mxGraphModel>)
                // rather than a base64 value attribute — serialize the inner XML.
                body = innerXml(diagram);
            }
            if (!body.isBlank() && !body.contains("<mxGraphModel") && !body.contains("<mxCell")) {
                // value may be a deflate+base64 payload
                try {
                    body = inflate(body);
                } catch (DrawioError e) {
                    // keep as-is
                }
            }
            List<Cell> cells = parseCells(body);
            pages.add(new Page(i, name.isBlank() ? "Page " + i : name, cells));
        }
        return pages;
    }

    private static List<Cell> parseCells(String body) {
        List<Cell> raw = new ArrayList<>();
        if (body.isBlank()) {
            return raw;
        }
        try {
            Document d = parseXmlSafely(body, "diagram");
            NodeList mxCells = d.getElementsByTagName("mxCell");
            Map<String, double[]> origins = new HashMap<>();
            Map<String, String> parents = new HashMap<>();
            for (int i = 0; i < mxCells.getLength(); i++) {
                Element c = (Element) mxCells.item(i);
                String id = c.getAttribute("id");
                String parent = c.getAttribute("parent");
                boolean vertex = "1".equals(c.getAttribute("vertex"));
                boolean edge = "1".equals(c.getAttribute("edge"));
                String source = c.getAttribute("source");
                String target = c.getAttribute("target");
                Element geom = childElement(c, "mxGeometry");
                double x = 0, y = 0, w = 0, h = 0;
                if (geom != null) {
                    x = num(geom.getAttribute("x"));
                    y = num(geom.getAttribute("y"));
                    w = num(geom.getAttribute("width"));
                    h = num(geom.getAttribute("height"));
                }
                parents.put(id, parent);
                origins.put(id, new double[] { x, y, w, h });
                String style = c.getAttribute("style");
                raw.add(new Cell(id, decodeLabel(c.getAttribute("value")), shapeFrom(style), parent,
                        source, target, x, y, w, h, vertex, edge));
            }
            // Resolve absolute geometry by walking the parent chain.
            List<Cell> resolved = new ArrayList<>();
            for (Cell cell : raw) {
                double[] rel = origins.get(cell.id());
                double absX = rel[0], absY = rel[1];
                String p = parents.get(cell.id());
                int guard = 0;
                while (p != null && !p.isEmpty() && !p.equals("1") && guard < 40) {
                    double[] po = origins.get(p);
                    if (po == null) {
                        break;
                    }
                    absX += po[0];
                    absY += po[1];
                    p = parents.get(p);
                    guard++;
                }
                resolved.add(new Cell(cell.id(), cell.label(), cell.shape(), cell.parent(),
                        cell.source(), cell.target(), absX, absY, rel[2], rel[3],
                        cell.vertex(), cell.edge()));
            }
            return resolved;
        } catch (DrawioError e) {
            return raw;
        }
    }

    private static Element childElement(Element parent, String name) {
        NodeList nl = parent.getChildNodes();
        for (int i = 0; i < nl.getLength(); i++) {
            Node n = nl.item(i);
            if (n.getNodeType() == Node.ELEMENT_NODE && n.getNodeName().equals(name)) {
                return (Element) n;
            }
        }
        return null;
    }

    /** Serialize the child element XML of {@code parent} (not text content). */
    private static String innerXml(Element parent) {
        StringBuilder sb = new StringBuilder();
        NodeList nl = parent.getChildNodes();
        for (int i = 0; i < nl.getLength(); i++) {
            Node n = nl.item(i);
            if (n.getNodeType() == Node.ELEMENT_NODE) {
                try {
                    javax.xml.transform.Transformer t =
                            javax.xml.transform.TransformerFactory.newInstance().newTransformer();
                    java.io.StringWriter w = new java.io.StringWriter();
                    t.transform(new javax.xml.transform.dom.DOMSource(n),
                            new javax.xml.transform.stream.StreamResult(w));
                    sb.append(w);
                } catch (Exception e) {
                    // ignore
                }
            }
        }
        return sb.toString();
    }

    private static double num(String s) {
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String shapeFrom(String style) {
        if (style == null || style.isBlank()) {
            return "rect";
        }
        String s = style.toLowerCase();
        if (s.contains("swimlane")) {
            return "swimlane";
        }
        if (s.contains("cylinder")) {
            return "cylinder";
        }
        if (s.contains("rhombus")) {
            return "rhombus";
        }
        if (s.contains("icon;")) {
            return "icon:" + iconName(style);
        }
        if (s.contains("note")) {
            return "note";
        }
        if (s.contains("table")) {
            return "table";
        }
        if (s.contains("ellipse")) {
            return "ellipse";
        }
        return "rect";
    }

    private static String iconName(String style) {
        int i = style.indexOf("icon;");
        if (i < 0) {
            return "generic";
        }
        String rest = style.substring(i + 5);
        int semicolon = rest.indexOf(';');
        return semicolon >= 0 ? rest.substring(0, semicolon) : rest;
    }

    private static String decodeLabel(String s) {
        if (s == null) {
            return "";
        }
        // Decode HTML entities and strip markup tags, preserving text content.
        String out = s.replace("&lt;", "<").replace("&gt;", ">")
                .replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", "\"")
                .replace("&nbsp;", " ");
        out = out.replaceAll("<br\\s*/?>", " ⏎ ");
        out = out.replaceAll("<[^>]+>", "");
        return out.trim();
    }

    // ------------------------------------------------------------------
    // digest rendering
    // ------------------------------------------------------------------

    private static List<Page> selectPages(List<Page> pages, String pageArg) {
        if (pageArg == null) {
            return List.of(pages.get(0));
        }
        if (pageArg.equals("all")) {
            return pages;
        }
        try {
            int n = Integer.parseInt(pageArg);
            for (Page p : pages) {
                if (p.index() == n) {
                    return List.of(p);
                }
            }
        } catch (NumberFormatException ignored) {
        }
        for (Page p : pages) {
            if (p.name().equalsIgnoreCase(pageArg)) {
                return List.of(p);
            }
        }
        throw new DrawioError("page not found: " + pageArg);
    }

    private static String renderDigest(String fileName, List<Page> all, List<Page> selected, int maxRows) {
        StringBuilder out = new StringBuilder();
        out.append("# draw.io IR — ").append(escapeInline(fileName)).append("\n\n");
        StringBuilder header = new StringBuilder();
        for (Page p : all) {
            if (header.length() > 0) {
                header.append(", ");
            }
            header.append("[").append(p.index()).append("] ").append(escapeInline(p.name()))
                    .append(" (").append(drawableCount(p)).append("n/").append(edgeCount(p)).append("e)");
        }
        out.append(header).append("\n\n");
        for (Page page : selected) {
            renderPage(out, page, maxRows);
        }
        return out.toString();
    }

    private static void renderPage(StringBuilder out, Page page, int maxRows) {
        List<Cell> edges = page.cells().stream().filter(c -> c.edge()).toList();
        // Drawable nodes: vertices whose parent is not an edge cell
        // (edge-label vertices like the source's own edge text are excluded).
        Set<String> edgeIds = edges.stream().map(Cell::id).collect(java.util.stream.Collectors.toSet());
        List<Cell> drawable = page.cells().stream()
                .filter(c -> c.vertex())
                .filter(c -> !edgeIds.contains(c.parent()))
                .toList();
        List<Cell> containers = drawable.stream().filter(c -> CONTAINER_SHAPES.contains(c.shape())).toList();
        out.append("## Page ").append(page.index()).append(" — ").append(escapeInline(page.name())).append("\n\n");

        double[] bbox = boundingBox(drawable);
        out.append("- source canvas: ").append(fmt(bbox[2])).append("×").append(fmt(bbox[3]))
                .append(" px (aspect ").append(String.format("%.2f", bbox[2] / Math.max(bbox[3], 1))).append(")\n");

        // Nodes/edges counts.
        int depth = maxDepth(drawable, containers);
        int dangling = (int) edges.stream().filter(e -> {
            Cell src = find(drawable, srcId(e));
            Cell tgt = find(drawable, tgtId(e));
            return src == null || tgt == null;
        }).count();
        out.append("- nodes: ").append(drawable.size()).append(" total / ").append(drawable.size())
                .append(" drawable / ").append(containers.size()).append(" containers, depth ").append(depth).append("\n");
        out.append("- edges: ").append(edges.size()).append(" (").append(labeledCount(edges)).append(" labeled, ")
                .append(dangling).append(" dangling), cycle: ").append(hasCycle(edges)).append("\n");

        // Shape histogram.
        Map<String, Long> shapes = new LinkedHashMap<>();
        for (Cell c : drawable) {
            shapes.merge(c.shape(), 1L, Long::sum);
        }
        out.append("- shapes: ").append(shapes).append("\n");

        // Type candidates (mechanical heuristic).
        List<String> typeCandidates = typeCandidates(drawable, edges, containers);
        out.append("- type candidates: ").append(String.join(", ", typeCandidates)).append("\n");

        // Budget.
        boolean overNodes = drawable.size() > 9;
        boolean overEdges = edges.size() > 12;
        out.append("- budget: nodes ").append(overNodes ? "OVER" : "ok").append(" (max 9), edges ")
                .append(overEdges ? "OVER" : "ok").append(" (max 12)\n");

        // Hubs.
        out.append("- hubs (focal candidates): ").append(hubs(drawable, edges, 5)).append("\n");
        out.append("- entry points: ").append(entryPoints(drawable, edges)).append("\n");
        out.append("- terminals: ").append(terminals(drawable, edges)).append("\n");

        // Unconnected.
        List<Cell> unconnected = drawable.stream()
                .filter(c -> !CONTAINER_SHAPES.contains(c.shape()))
                .filter(c -> !isConnected(c, edges))
                .toList();
        if (!unconnected.isEmpty()) {
            out.append("- unconnected: ").append(unconnected.stream()
                    .map(c -> escapeInline(label(c))).toList()).append("\n");
        }

        // Collapsible groups (containers with leaf children).
        List<String> collapsible = new ArrayList<>();
        for (Cell container : containers) {
            long leafChildren = drawable.stream()
                    .filter(c -> container.id().equals(c.parent()))
                    .filter(c -> !CONTAINER_SHAPES.contains(c.shape()))
                    .count();
            if (leafChildren > 0) {
                collapsible.add(container.id() + " — " + leafChildren + " children");
            }
        }
        if (!collapsible.isEmpty()) {
            out.append("- collapsible groups (simplify here first):\n");
            for (String g : collapsible) {
                out.append("  - ").append(g).append("\n");
            }
        }

        // Nodes table.
        out.append("\n### Nodes\n\n");
        out.append("| id | label | shape | depth | parent | deg | box |\n");
        out.append("|---|---|---|---|---|---|---|\n");
        int shown = 0;
        for (Cell c : drawable) {
            if (shown >= maxRows) {
                break;
            }
            shown++;
            int deg = degree(c, edges);
            String box = fmt(c.x()) + "," + fmt(c.y()) + " " + fmt(c.w()) + "×" + fmt(c.h());
            String parent = c.parent() == null || c.parent().isEmpty() ? "1" : c.parent();
            out.append("| ").append(escapeInline(c.id())).append(" | ").append(escapeInline(label(c)))
                    .append(" | ").append(c.shape()).append(" | ").append(depthOf(c, containers))
                    .append(" | ").append(escapeInline(parent)).append(" | ").append(deg)
                    .append(" | ").append(box).append(" |\n");
        }
        if (drawable.size() > shown) {
            out.append("| … | ").append(drawable.size() - shown).append(" more | | | | | |\n");
        }

        // Edges table.
        out.append("\n### Edges\n\n");
        out.append("| source | target | label | style |\n");
        out.append("|---|---|---|---|\n");
        int shownE = 0;
        for (Cell e : edges) {
            if (shownE >= maxRows) {
                break;
            }
            shownE++;
            String srcName = cellLabel(drawable, srcId(e));
            String tgtName = cellLabel(drawable, tgtId(e));
            out.append("| ").append(escapeInline(srcName)).append(" | ").append(escapeInline(tgtName))
                    .append(" | ").append(escapeInline(e.label())).append(" | - |\n");
        }
    }

    private static String cellLabel(List<Cell> drawable, String id) {
        for (Cell c : drawable) {
            if (c.id().equals(id)) {
                return label(c);
            }
        }
        return id;
    }

    private static int drawableCount(Page p) {
        return (int) p.cells().stream().filter(c -> c.vertex()).count();
    }

    private static int edgeCount(Page p) {
        return (int) p.cells().stream().filter(c -> c.edge()).count();
    }

    private static String label(Cell c) {
        return c.label().isBlank() ? "-" : c.label();
    }

    private static double[] boundingBox(List<Cell> cells) {
        double maxX = 0, maxY = 0;
        for (Cell c : cells) {
            maxX = Math.max(maxX, c.x() + c.w());
            maxY = Math.max(maxY, c.y() + c.h());
        }
        return new double[] { 0, 0, maxX, maxY };
    }

    private static int maxDepth(List<Cell> drawable, List<Cell> containers) {
        int max = 0;
        for (Cell c : drawable) {
            max = Math.max(max, depthOf(c, containers));
        }
        return max;
    }

    private static int depthOf(Cell c, List<Cell> containers) {
        int d = 0;
        String p = c.parent();
        while (p != null && !p.isEmpty() && d < 20) {
            boolean found = false;
            for (Cell cont : containers) {
                if (cont.id().equals(p)) {
                    p = cont.parent();
                    d++;
                    found = true;
                    break;
                }
            }
            if (!found) {
                break;
            }
        }
        return d;
    }

    private static List<String> typeCandidates(List<Cell> drawable, List<Cell> edges, List<Cell> containers) {
        List<String> out = new ArrayList<>();
        boolean hasRhombus = drawable.stream().anyMatch(c -> c.shape().equals("rhombus"));
        boolean hasCylinder = drawable.stream().anyMatch(c -> c.shape().equals("cylinder"));
        boolean hasSwimlane = drawable.stream().anyMatch(c -> c.shape().equals("swimlane"));
        boolean hasIcon = drawable.stream().anyMatch(c -> c.shape().startsWith("icon:"));
        boolean hasTable = drawable.stream().anyMatch(c -> c.shape().equals("table"));
        if (hasRhombus) {
            out.add("flowchart");
        }
        if (hasIcon || (!hasRhombus && !hasCylinder && !hasSwimlane)) {
            out.add("architecture");
        }
        if (hasCylinder && hasTable) {
            out.add("er");
        }
        if (hasSwimlane) {
            out.add("swimlane");
        }
        if (containers.size() >= 2 && edges.size() <= 4) {
            out.add("nested");
        }
        if (out.isEmpty()) {
            out.add("architecture");
        }
        return out;
    }

    private static String hubs(List<Cell> drawable, List<Cell> edges, int limit) {
        Map<String, Integer> deg = new LinkedHashMap<>();
        for (Cell e : edges) {
            String src = srcId(e);
            String tgt = tgtId(e);
            if (!src.isEmpty()) {
                deg.merge(src, 1, Integer::sum);
            }
            if (!tgt.isEmpty()) {
                deg.merge(tgt, 1, Integer::sum);
            }
        }
        List<String> ranked = new ArrayList<>();
        deg.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .limit(limit)
                .forEach(en -> {
                    Cell c = find(drawable, en.getKey());
                    ranked.add((c == null ? en.getKey() : escapeInline(label(c))) + "(" + en.getValue() + ")");
                });
        return String.join(", ", ranked);
    }

    private static String entryPoints(List<Cell> drawable, List<Cell> edges) {
        List<String> names = new ArrayList<>();
        for (Cell c : drawable) {
            if (CONTAINER_SHAPES.contains(c.shape())) {
                continue;
            }
            boolean hasIncoming = edges.stream().anyMatch(e -> tgtId(e).equals(c.id()));
            if (!hasIncoming) {
                names.add(escapeInline(label(c)));
            }
        }
        return names.isEmpty() ? "none" : String.join(", ", names);
    }

    private static String terminals(List<Cell> drawable, List<Cell> edges) {
        List<String> names = new ArrayList<>();
        for (Cell c : drawable) {
            if (CONTAINER_SHAPES.contains(c.shape())) {
                continue;
            }
            boolean hasOutgoing = edges.stream().anyMatch(e -> srcId(e).equals(c.id()));
            if (!hasOutgoing) {
                names.add(escapeInline(label(c)));
            }
        }
        return names.isEmpty() ? "none" : String.join(", ", names);
    }

    private static String srcId(Cell e) {
        return e.source() == null || e.source().isEmpty() ? "" : e.source();
    }

    private static String tgtId(Cell e) {
        return e.target() == null || e.target().isEmpty() ? "" : e.target();
    }

    private static boolean isConnected(Cell c, List<Cell> edges) {
        return edges.stream().anyMatch(e -> srcId(e).equals(c.id()) || tgtId(e).equals(c.id()));
    }

    private static int degree(Cell c, List<Cell> edges) {
        int d = 0;
        for (Cell e : edges) {
            if (srcId(e).equals(c.id()) || tgtId(e).equals(c.id())) {
                d++;
            }
        }
        return d;
    }

    private static Cell find(List<Cell> cells, String id) {
        for (Cell c : cells) {
            if (c.id().equals(id)) {
                return c;
            }
        }
        return null;
    }

    private static int labeledCount(List<Cell> edges) {
        return (int) edges.stream().filter(e -> !e.label().isBlank()).count();
    }

    private static boolean hasCycle(List<Cell> edges) {
        // Simple cycle detection over the edge source->target graph.
        Map<String, List<String>> adj = new HashMap<>();
        for (Cell e : edges) {
            adj.computeIfAbsent(srcId(e), k -> new ArrayList<>()).add(tgtId(e));
        }
        Set<String> visited = new java.util.HashSet<>();
        Set<String> stack = new java.util.HashSet<>();
        for (String node : adj.keySet()) {
            if (dfsCycle(node, adj, visited, stack)) {
                return true;
            }
        }
        return false;
    }

    private static boolean dfsCycle(String node, Map<String, List<String>> adj, Set<String> visited, Set<String> stack) {
        if (stack.contains(node)) {
            return true;
        }
        if (visited.contains(node)) {
            return false;
        }
        visited.add(node);
        stack.add(node);
        for (String next : adj.getOrDefault(node, List.of())) {
            if (dfsCycle(next, adj, visited, stack)) {
                return true;
            }
        }
        stack.remove(node);
        return false;
    }

    private static String escapeInline(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ⏎ ");
    }

    private static String fmt(double v) {
        if (v == Math.floor(v)) {
            return String.valueOf((long) v);
        }
        return String.valueOf(v);
    }
}
