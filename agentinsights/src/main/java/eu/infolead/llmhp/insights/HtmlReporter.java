package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.util.*;

public final class HtmlReporter {

    static final String SATISFACTION_ORDER = "frustrated,dissatisfied,likely_satisfied,satisfied,happy,unsure";
    static final String OUTCOME_ORDER = "not_achieved,partially_achieved,mostly_achieved,fully_achieved,unclear_from_transcript";

    public static String generate(AggregatedData data, InsightResults insights) {
        var sb = new StringBuilder();
        head(sb);
        headerSection(sb, data);
        atAGlanceSection(sb, insights);
        projectAreasSection(sb, insights);
        interactionSection(sb, insights);
        whatWorksSection(sb, insights);
        frictionSection(sb, insights);
        suggestionsSection(sb, insights);
        horizonSection(sb, insights);
        funEndingSection(sb, insights);
        statsAppendix(sb, data);
        tail(sb);
        return sb.toString();
    }

    static void head(StringBuilder sb) {
        sb.append("""
            <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>AI Coding Insights</title>
            <style>
            *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
            body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6;padding:2rem;max-width:900px;margin:0 auto}
            h1{font-size:2rem;font-weight:700;margin-bottom:0.5rem;background:linear-gradient(135deg,#818cf8,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
            h2{font-size:1.3rem;font-weight:600;margin-top:2.5rem;margin-bottom:1rem;color:#c7d2fe;border-bottom:1px solid #1e293b;padding-bottom:0.5rem}
            h3{font-size:1rem;font-weight:600;margin:1rem 0 0.5rem;color:#a5b4fc}
            .meta{font-size:0.85rem;color:#94a3b8;margin-bottom:1.5rem}
            .stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:0.75rem;margin:1rem 0}
            .stat-card{background:#1e293b;border-radius:8px;padding:0.75rem 1rem;text-align:center;border:1px solid #334155}
            .stat-value{font-size:1.5rem;font-weight:700;color:#818cf8}
            .stat-label{font-size:0.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em}
            .at-a-glance{background:linear-gradient(135deg,#1e1b4b,#172554);border-radius:12px;padding:1.5rem;margin:2rem 0;border:1px solid #4338ca}
            .glance-title{font-size:1.1rem;font-weight:700;color:#a5b4fc;margin-bottom:1rem}
            .glance-section{margin-bottom:0.75rem;font-size:0.9rem}
            .glance-section strong{color:#c7d2fe}
            .project-area,.friction-category{background:#1e293b;border-radius:8px;padding:1rem;margin:0.5rem 0;border:1px solid #334155}
            .area-header,.friction-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.25rem}
            .area-name,.friction-title{font-weight:600;color:#c7d2fe}
            .area-count{font-size:0.8rem;color:#64748b}
            .area-desc,.friction-desc{font-size:0.85rem;color:#94a3b8}
            .narrative{background:#1e293b;border-radius:8px;padding:1rem;margin:0.5rem 0;border-left:3px solid #6366f1}
            .key-insight{margin-top:0.5rem;font-size:0.85rem;color:#a5b4fc}
            .impressive-workflow,.feature-item,.pattern-item{background:#1e293b;border-radius:8px;padding:1rem;margin:0.5rem 0;border-left:3px solid #22c55e}
            .impressive-workflow-title,.feature-title,.pattern-title{font-weight:600;color:#c7d2fe;margin-bottom:0.25rem}
            .impressive-workflow-desc,.feature-desc,.pattern-desc{font-size:0.85rem;color:#94a3b8}
            .friction-category ul{margin-top:0.5rem;padding-left:1.25rem;font-size:0.8rem;color:#94a3b8}
            .friction-category li{margin-bottom:0.25rem}
            .claude-md-section{margin:1rem 0}
            .claude-md-item{margin-bottom:1rem}
            .claude-md-item label{display:block}
            .cmd-code{background:#0f172a;padding:0.4rem 0.75rem;border-radius:4px;font-size:0.8rem;display:inline-block;margin:0.25rem 0;color:#a5b4fc;border:1px solid #334155;word-break:break-all;max-width:100%}
            .cmd-why{font-size:0.8rem;color:#64748b;margin-top:0.25rem}
            .copy-btn,.copy-all-btn{background:#4338ca;color:white;border:none;padding:0.35rem 0.75rem;border-radius:4px;cursor:pointer;font-size:0.75rem;margin-left:0.5rem}
            .copy-btn:hover,.copy-all-btn:hover{background:#4f46e5}
            .copy-all-btn{margin-bottom:0.75rem}
            .features-section{margin:1rem 0}
            .feature-item{border-left-color:#8b5cf6;font-size:0.85rem}
            .horizon-item{background:#1e293b;border-radius:8px;padding:1rem;margin:0.5rem 0;border-left:3px solid #f59e0b}
            .horizon-title{font-weight:600;color:#c7d2fe;margin-bottom:0.25rem}
            .horizon-desc{font-size:0.85rem;color:#94a3b8}
            .fun-ending{background:linear-gradient(135deg,#1e293b,#172554);border-radius:12px;padding:1.5rem;margin:2rem 0;text-align:center}
            .fun-headline{font-size:1.2rem;font-weight:600;color:#fbbf24;margin-bottom:0.5rem}
            .fun-detail{font-size:0.85rem;color:#94a3b8}
            .bar-row{display:flex;align-items:center;margin-bottom:6px;gap:8px}
            .bar-label{width:140px;font-size:0.8rem;text-align:right;color:#94a3b8;flex-shrink:0}
            .bar-track{flex:1;height:18px;background:#1e293b;border-radius:4px;overflow:hidden}
            .bar-fill{height:100%;border-radius:4px;transition:width 0.3s}
            .bar-value{width:40px;font-size:0.75rem;color:#cbd5e1;text-align:left;flex-shrink:0}
            .chart-section{margin:1rem 0}
            .chart-section h3{font-size:0.9rem;color:#a5b4fc;margin-bottom:0.5rem}
            p.empty{color:#64748b;font-style:italic;font-size:0.8rem}
            a{color:#818cf8}
            hr{border:none;border-top:1px solid #1e293b;margin:2rem 0}
            pre{background:#0f172a;padding:0.75rem;border-radius:6px;font-size:0.8rem;overflow-x:auto;color:#cbd5e1}
            </style></head><body>
            """);
    }

    static void tail(StringBuilder sb) {
        sb.append("</body></html>");
    }

    static void headerSection(StringBuilder sb, AggregatedData d) {
        sb.append("<h1>AI Coding Insights</h1>");
        sb.append("<div class=\"meta\">").append(esc(d.dateRange().start()))
            .append(" &mdash; ").append(esc(d.dateRange().end())).append(" &middot; ")
            .append(d.totalSessions()).append(" sessions &middot; ")
            .append(String.format("%.0f", d.totalDurationHours())).append(" hours &middot; ")
            .append(d.totalMessages()).append(" messages</div>");
        sb.append("""
            <div class="stats-grid">
            """);
        stat(sb, String.format("%.0f", d.totalDurationHours()), "Total Hours");
        stat(sb, String.valueOf(d.totalSessions()), "Sessions");
        stat(sb, String.valueOf(d.totalMessages()), "Messages");
        stat(sb, String.valueOf(d.daysActive()), "Active Days");
        stat(sb, String.valueOf(d.gitCommits()), "Commits");
        stat(sb, "+" + d.totalLinesAdded() + "/-" + d.totalLinesRemoved(), "Lines");
        sb.append("</div>");
    }

    static void stat(StringBuilder sb, String val, String label) {
        sb.append("<div class=\"stat-card\"><div class=\"stat-value\">").append(esc(val))
            .append("</div><div class=\"stat-label\">").append(esc(label)).append("</div></div>");
    }

    static void atAGlanceSection(StringBuilder sb, InsightResults i) {
        var ata = i.atAGlance();
        if (ata.isEmpty()) return;
        var a = ata.get();
        sb.append("<div class=\"at-a-glance\"><div class=\"glance-title\">At a Glance</div><div class=\"glance-sections\">");
        if (!a.whatsWorking().isBlank())
            sb.append("<div class=\"glance-section\"><strong>What's working:</strong> ").append(escBold(a.whatsWorking()))
                .append("</div>");
        if (!a.whatsHindering().isBlank())
            sb.append("<div class=\"glance-section\"><strong>What's hindering:</strong> ").append(escBold(a.whatsHindering()))
                .append("</div>");
        if (!a.quickWins().isBlank())
            sb.append("<div class=\"glance-section\"><strong>Quick wins:</strong> ").append(escBold(a.quickWins()))
                .append("</div>");
        if (!a.ambitiousWorkflows().isBlank())
            sb.append("<div class=\"glance-section\"><strong>Ambitious workflows:</strong> ").append(escBold(a.ambitiousWorkflows()))
                .append("</div>");
        sb.append("</div></div>");
    }

    static void projectAreasSection(StringBuilder sb, InsightResults i) {
        var pa = i.projectAreas();
        if (pa.isEmpty() || pa.get().areas().isEmpty()) return;
        sb.append("<h2>What You Work On</h2>");
        for (var area : pa.get().areas()) {
            sb.append("<div class=\"project-area\"><div class=\"area-header\"><span class=\"area-name\">")
                .append(esc(area.name())).append("</span><span class=\"area-count\">~")
                .append(area.sessionCount()).append(" sessions</span></div>")
                .append("<div class=\"area-desc\">").append(esc(area.description())).append("</div></div>");
        }
    }

    static void interactionSection(StringBuilder sb, InsightResults i) {
        var is = i.interactionStyle();
        if (is.isEmpty() || is.get().narrative().isBlank()) return;
        sb.append("<h2>How You Interact</h2><div class=\"narrative\">")
            .append(mdP(esc(is.get().narrative())));
        if (!is.get().keyPattern().isBlank())
            sb.append("<div class=\"key-insight\"><strong>Key pattern:</strong> ").append(esc(is.get().keyPattern())).append("</div>");
        sb.append("</div>");
    }

    static void whatWorksSection(StringBuilder sb, InsightResults i) {
        var ww = i.whatWorks();
        if (ww.isEmpty() || ww.get().impressiveWorkflows().isEmpty()) return;
        sb.append("<h2>Impressive Accomplishments</h2>");
        if (!ww.get().intro().isBlank()) sb.append("<p style=\"color:#94a3b8;margin-bottom:0.5rem\">").append(esc(ww.get().intro())).append("</p>");
        for (var wf : ww.get().impressiveWorkflows()) {
            sb.append("<div class=\"impressive-workflow\"><div class=\"impressive-workflow-title\">")
                .append(esc(wf.title())).append("</div><div class=\"impressive-workflow-desc\">")
                .append(esc(wf.description())).append("</div></div>");
        }
    }

    static void frictionSection(StringBuilder sb, InsightResults i) {
        var fa = i.frictionAnalysis();
        if (fa.isEmpty() || fa.get().categories().isEmpty()) return;
        sb.append("<h2>Where Things Go Wrong</h2>");
        if (!fa.get().intro().isBlank()) sb.append("<p style=\"color:#94a3b8;margin-bottom:0.5rem\">").append(esc(fa.get().intro())).append("</p>");
        for (var cat : fa.get().categories()) {
            sb.append("<div class=\"friction-category\"><div class=\"friction-title\">")
                .append(esc(cat.category())).append("</div><div class=\"friction-desc\">")
                .append(esc(cat.description())).append("</div>");
            cat.examples().ifPresent(ex -> {
                sb.append("<ul>");
                for (var e : ex) sb.append("<li>").append(esc(e)).append("</li>");
                sb.append("</ul>");
            });
            sb.append("</div>");
        }
    }

    static void suggestionsSection(StringBuilder sb, InsightResults i) {
        var s = i.suggestions();
        if (s.isEmpty()) return;
        var sug = s.get();

        if (!sug.claudeMdAdditions().isEmpty()) {
            sb.append("<h2>Instructions to Add</h2>")
                .append("<p style=\"font-size:12px;color:#64748b;margin-bottom:0.75rem\">Copy these into your project's instruction file.</p>");
            for (var add : sug.claudeMdAdditions()) {
                sb.append("<div class=\"claude-md-item\"><code class=\"cmd-code\">")
                    .append(esc(add.addition())).append("</code>");
                if (!add.why().isBlank())
                    sb.append("<div class=\"cmd-why\">").append(esc(add.why())).append("</div>");
                sb.append("</div>");
            }
        }

        if (!sug.featuresToTry().isEmpty()) {
            sb.append("<h2>Features to Try</h2><div class=\"features-section\">");
            for (var ft : sug.featuresToTry()) {
                sb.append("<div class=\"feature-item\"><div class=\"feature-title\">")
                    .append(esc(ft.feature())).append(": ").append(esc(ft.oneLiner()))
                    .append("</div><div class=\"feature-desc\">").append(esc(ft.whyForYou())).append("</div>");
                ft.exampleCode().ifPresent(code ->
                    sb.append("<pre>").append(esc(code)).append("</pre>"));
                sb.append("</div>");
            }
            sb.append("</div>");
        }

        if (!sug.usagePatterns().isEmpty()) {
            sb.append("<h2>Usage Patterns</h2>");
            for (var p : sug.usagePatterns()) {
                sb.append("<div class=\"pattern-item\"><div class=\"pattern-title\">")
                    .append(esc(p.title())).append("</div><div class=\"pattern-desc\">")
                    .append(esc(p.suggestion())).append("</div>");
                p.detail().ifPresent(d ->
                    sb.append("<div class=\"pattern-desc\" style=\"margin-top:0.25rem\">").append(esc(d)).append("</div>"));
                sb.append("</div>");
            }
        }
    }

    static void horizonSection(StringBuilder sb, InsightResults i) {
        var oh = i.onTheHorizon();
        if (oh.isEmpty() || oh.get().opportunities().isEmpty()) return;
        sb.append("<h2>On the Horizon</h2>");
        if (!oh.get().intro().isBlank()) sb.append("<p style=\"color:#94a3b8;margin-bottom:0.5rem\">").append(esc(oh.get().intro())).append("</p>");
        for (var op : oh.get().opportunities()) {
            sb.append("<div class=\"horizon-item\"><div class=\"horizon-title\">")
                .append(esc(op.title())).append("</div><div class=\"horizon-desc\">")
                .append(esc(op.whatsPossible())).append("</div></div>");
        }
    }

    static void funEndingSection(StringBuilder sb, InsightResults i) {
        var fe = i.funEnding();
        if (fe.isEmpty() || fe.get().headline().isBlank()) return;
        sb.append("<div class=\"fun-ending\"><div class=\"fun-headline\">")
            .append(esc(fe.get().headline())).append("</div>");
        if (!fe.get().detail().isBlank())
            sb.append("<div class=\"fun-detail\">").append(esc(fe.get().detail())).append("</div>");
        sb.append("</div>");
    }

    static void statsAppendix(StringBuilder sb, AggregatedData d) {
        sb.append("<hr><h2>Stats Appendix</h2>");

        sb.append("<div class=\"chart-section\"><h3>Outcomes</h3>");
        sb.append(renderBarsOrdered(d.outcomes(), OUTCOME_ORDER, "#22c55e"));
        sb.append("</div>");

        sb.append("<div class=\"chart-section\"><h3>Satisfaction</h3>");
        sb.append(renderBarsOrdered(d.satisfaction(), SATISFACTION_ORDER, "#f59e0b"));
        sb.append("</div>");

        sb.append("<div class=\"chart-section\"><h3>Goal Categories</h3>");
        sb.append(renderBars(d.goalCategories(), "#818cf8", 8));
        sb.append("</div>");

        sb.append("<div class=\"chart-section\"><h3>Top Tools</h3>");
        sb.append(renderBars(d.toolCounts(), "#6366f1", 8));
        sb.append("</div>");

        if (!d.friction().isEmpty()) {
            sb.append("<div class=\"chart-section\"><h3>Friction Types</h3>");
            sb.append(renderBars(d.friction(), "#ef4444", 8));
            sb.append("</div>");
        }

        if (!d.languages().isEmpty()) {
            sb.append("<div class=\"chart-section\"><h3>Languages</h3>");
            sb.append(renderBars(d.languages(), "#14b8a6", 8));
            sb.append("</div>");
        }

        if (!d.userResponseTimes().isEmpty()) {
            sb.append("<div class=\"chart-section\"><h3>Response Times</h3>");
            sb.append(renderResponseTimeHistogram(d.userResponseTimes()));
            sb.append("</div>");
        }

        if (!d.toolErrorCategories().isEmpty()) {
            sb.append("<div class=\"chart-section\"><h3>Tool Error Categories</h3>");
            sb.append(renderBars(d.toolErrorCategories(), "#f87171", 8));
            sb.append("</div>");
        }

        sb.append("<hr><p style=\"color:#475569;font-size:0.75rem;text-align:center\">Generated by agentinsights</p>");
    }

    static String renderBars(Map<String, Integer> data, String color, int maxItems) {
        if (data.isEmpty()) return "<p class=\"empty\">No data</p>";
        var entries = data.entrySet().stream()
            .sorted((a, b) -> b.getValue().compareTo(a.getValue()))
            .limit(maxItems).toList();
        return buildBarsHtml(entries, color);
    }

    static String renderBarsOrdered(Map<String, Integer> data, String orderStr, String color) {
        if (data.isEmpty()) return "<p class=\"empty\">No data</p>";
        var order = List.of(orderStr.split(","));
        var entries = order.stream()
            .filter(k -> data.containsKey(k) && data.getOrDefault(k, 0) > 0)
            .map(k -> Map.entry(k, data.getOrDefault(k, 0)))
            .toList();
        if (entries.isEmpty()) return "<p class=\"empty\">No data</p>";
        return buildBarsHtml(entries, color);
    }

    static String buildBarsHtml(List<Map.Entry<String, Integer>> entries, String color) {
        var max = entries.stream().mapToInt(Map.Entry::getValue).max().orElse(1);
        var sb = new StringBuilder();
        for (var e : entries) {
            var pct = (double) e.getValue() / max * 100;
            var label = Labels.display(e.getKey());
            sb.append("<div class=\"bar-row\"><div class=\"bar-label\">").append(esc(label))
                .append("</div><div class=\"bar-track\"><div class=\"bar-fill\" style=\"width:")
                .append(String.format("%.0f", pct)).append("%;background:").append(color)
                .append("\"></div></div><div class=\"bar-value\">").append(e.getValue()).append("</div></div>");
        }
        return sb.toString();
    }

    static String renderResponseTimeHistogram(List<Double> times) {
        if (times.isEmpty()) return "<p class=\"empty\">No data</p>";
        var buckets = new LinkedHashMap<String, Integer>();
        buckets.put("2-10s", 0); buckets.put("10-30s", 0); buckets.put("30s-1m", 0);
        buckets.put("1-2m", 0); buckets.put("2-5m", 0); buckets.put("5-15m", 0); buckets.put(">15m", 0);
        for (var t : times) {
            if (t < 10) buckets.merge("2-10s", 1, Integer::sum);
            else if (t < 30) buckets.merge("10-30s", 1, Integer::sum);
            else if (t < 60) buckets.merge("30s-1m", 1, Integer::sum);
            else if (t < 120) buckets.merge("1-2m", 1, Integer::sum);
            else if (t < 300) buckets.merge("2-5m", 1, Integer::sum);
            else if (t < 900) buckets.merge("5-15m", 1, Integer::sum);
            else buckets.merge(">15m", 1, Integer::sum);
        }
        var max = buckets.values().stream().mapToInt(Integer::intValue).max().orElse(1);
        if (max == 0) return "<p class=\"empty\">No data</p>";
        var sb = new StringBuilder();
        for (var e : buckets.entrySet()) {
            var pct = (double) e.getValue() / max * 100;
            sb.append("<div class=\"bar-row\"><div class=\"bar-label\">").append(e.getKey())
                .append("</div><div class=\"bar-track\"><div class=\"bar-fill\" style=\"width:")
                .append(String.format("%.0f", pct)).append("%;background:#6366f1")
                .append("\"></div></div><div class=\"bar-value\">").append(e.getValue()).append("</div></div>");
        }
        return sb.toString();
    }

    static String esc(String s) {
        if (s == null) return "";
        var sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            switch (c) { case '&' -> sb.append("&amp;"); case '<' -> sb.append("&lt;"); case '>' -> sb.append("&gt;"); case '"' -> sb.append("&quot;"); default -> sb.append(c); }
        }
        return sb.toString();
    }

    static String escBold(String s) {
        if (s == null) return "";
        return esc(s).replaceAll("\\*\\*(.+?)\\*\\*", "<strong>$1</strong>");
    }

    static String mdP(String s) {
        if (s == null) return "";
        return s.replace("\n\n", "</p><p>").replace("\n", "<br>");
    }
}
