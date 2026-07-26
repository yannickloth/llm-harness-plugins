package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.util.*;

public final class MarkdownSummarizer {

    public static String generate(AggregatedData data, InsightResults insights, String reportPath) {
        var sb = new StringBuilder();
        sb.append("# Insights Report\n\n");
        sb.append("**Date range:** ").append(data.dateRange().start())
            .append(" to ").append(data.dateRange().end()).append("\n\n");

        var ata = insights.atAGlance();
        if (ata.isPresent()) {
            var a = ata.get();
            sb.append("## At a Glance\n\n");
            if (!a.whatsWorking().isBlank()) sb.append("**What's working:** ").append(a.whatsWorking()).append("\n\n");
            if (!a.whatsHindering().isBlank()) sb.append("**What's hindering:** ").append(a.whatsHindering()).append("\n\n");
            if (!a.quickWins().isBlank()) sb.append("**Quick wins:** ").append(a.quickWins()).append("\n\n");
            if (!a.ambitiousWorkflows().isBlank()) sb.append("**On the horizon:** ").append(a.ambitiousWorkflows()).append("\n\n");
        }

        sb.append("## Key Stats\n\n");
        sb.append("- **Sessions analyzed:** ").append(data.totalSessions()).append("\n");
        sb.append("- **Total messages:** ").append(data.totalMessages()).append("\n");
        sb.append("- **Total hours:** ").append(String.format("%.1f", data.totalDurationHours())).append("\n");
        sb.append("- **Active days:** ").append(data.daysActive()).append("\n");
        sb.append("- **Commits:** ").append(data.gitCommits()).append("\n");
        sb.append("- **Files modified:** ").append(data.totalFilesModified()).append("\n");
        sb.append("- **Lines added/removed:** +").append(data.totalLinesAdded())
            .append(" / -").append(data.totalLinesRemoved()).append("\n");
        sb.append("- **Response time (median):** ").append(String.format("%.0f", data.medianResponseTime())).append("s\n\n");

        if (!data.toolCounts().isEmpty()) {
            sb.append("### Top Tools\n\n");
            data.toolCounts().entrySet().stream()
                .sorted((a, b) -> b.getValue().compareTo(a.getValue()))
                .limit(6)
                .forEach(e -> sb.append("- ").append(e.getKey()).append(": ").append(e.getValue()).append("\n"));
            sb.append("\n");
        }

        if (!data.goalCategories().isEmpty()) {
            sb.append("### Top Goals\n\n");
            data.goalCategories().entrySet().stream()
                .sorted((a, b) -> b.getValue().compareTo(a.getValue()))
                .limit(6)
                .forEach(e -> sb.append("- ").append(Labels.label(e.getKey()))
                    .append(": ").append(e.getValue()).append("\n"));
            sb.append("\n");
        }

        if (!data.languages().isEmpty()) {
            sb.append("### Languages\n\n");
            data.languages().entrySet().stream()
                .sorted((a, b) -> b.getValue().compareTo(a.getValue()))
                .limit(6)
                .forEach(e -> sb.append("- ").append(e.getKey()).append(": ").append(e.getValue()).append("\n"));
            sb.append("\n");
        }

        var friction = insights.frictionAnalysis();
        if (friction.isPresent() && !friction.get().categories().isEmpty()) {
            sb.append("## Friction Areas\n\n");
            for (var cat : friction.get().categories())
                sb.append("- **").append(cat.category()).append(":** ").append(cat.description()).append("\n");
            sb.append("\n");
        }

        var fun = insights.funEnding();
        if (fun.isPresent()) {
            sb.append("---\n\n");
            sb.append("*").append(fun.get().headline()).append("*\n\n");
            if (!fun.get().detail().isBlank())
                sb.append(fun.get().detail()).append("\n");
        }

        sb.append("\n---\n\n");
        sb.append("[Open full HTML report](").append(reportPath).append(")\n");

        return sb.toString();
    }
}
