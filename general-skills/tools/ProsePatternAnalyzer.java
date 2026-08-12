import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.*;
import java.util.stream.*;

/**
 * ProsePatternAnalyzer - Deterministic analysis of AI-style prose patterns
 *
 * Provides pattern detection, metric calculation, and severity scoring for
 * identifying prose patterns that may affect naturalness and readability.
 */
public class ProsePatternAnalyzer {

    // Pattern regex definitions
    private static final Pattern TRANSITION_STACKING = Pattern.compile(
        "\\b(however|furthermore|moreover|additionally|consequently|therefore|" +
        "moreover|nevertheless|nonetheless|meanwhile|furthermore)\\b.*" +
        "\\b(furthermore|moreover|additionally|consequently|therefore|" +
        "nevertheless|nonetheless|meanwhile)\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static final Pattern HEDGE_STACKING = Pattern.compile(
        "\\b(might|could|may|possibly|potentially|perhaps|arguably|apparently|" +
        "seemingly|supposedly|presumably|ostensibly)\\b.*" +
        "\\b(might|could|may|possibly|potentially|perhaps|arguably|apparently|" +
        "seemingly|supposedly|presumably|ostensibly)\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static final Pattern TEACHING_TONE = Pattern.compile(
        "\\b(let's|let us|it's helpful to|we can see that|" +
        "it's worth noting|it's important to understand|let's explore|" +
        "we should consider|it's useful to note)\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static final Pattern FORMULAIC_OPENING = Pattern.compile(
        "^(In conclusion|Furthermore|Additionally|Moreover|" +
        "It is worth noting that|It is important to note that|" +
        "To summarize|In summary|Finally|Lastly)\\b",
        Pattern.CASE_INSENSITIVE | Pattern.MULTILINE
    );

    private static final Pattern PASSIVE_VOICE = Pattern.compile(
        "\\b(was|were|is|are|been|being)\\s+\\w+ed\\s+by\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static final Pattern ABSTRACT_NOUN_CHAIN = Pattern.compile(
        "\\b(the|a|an)?\\s*(implementation|utilization|facilitation|optimization|" +
        "conceptualization|operationalization|standardization|systematization)\\s+" +
        "(of|the|a|an)?\\s*\\w+\\s+(of|the|a|an)?\\s*" +
        "(implementation|utilization|facilitation|optimization)\\s+",
        Pattern.CASE_INSENSITIVE
    );

    private static final Pattern FALSE_BALANCE = Pattern.compile(
        "\\b(while|although|though|whereas)\\s+.+\\s+" +
        "\\b(others?\\s+(argue|claim|suggest|maintain|posit)|" +
        "conversely|on the other hand|alternatively)\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static final Pattern SUMMARY_INFLATION = Pattern.compile(
        "\\b(in conclusion|to summarize|in summary|in short|ultimately|" +
        "therefore|thus|hence|consequently)\\s*,\\s*(we have seen that|" +
        "this demonstrates that|this shows that|this indicates that|" +
        "what we've discussed|as mentioned above)\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static final Pattern OVER_EXPLANATION = Pattern.compile(
        "\\b(it is important to understand|it is worth noting|" +
        "it should be noted that|it is crucial to recognize|" +
        "it is essential to understand|it is vital to note)\\b",
        Pattern.CASE_INSENSITIVE
    );

    // Abstract noun indicators
    private static final Set<String> ABSTRACT_NOUNS = Set.of(
        "implementation", "utilization", "facilitation", "optimization",
        "conceptualization", "operationalization", "standardization",
        "systematization", "abstraction",
        "generalization", "specification", "formalization"
    );

    // Transition words
    private static final Set<String> TRANSITION_WORDS = Set.of(
        "however", "furthermore", "moreover", "additionally", "consequently",
        "therefore", "nevertheless", "nonetheless", "meanwhile",
        "accordingly", "hence", "thus", "otherwise",
        "incidentally"
    );

    // Hedging words
    private static final Set<String> HEDGING_WORDS = Set.of(
        "might", "could", "may", "possibly", "potentially", "perhaps",
        "arguably", "apparently", "seemingly", "supposedly", "presumably",
        "ostensibly", "somewhat", "rather", "quite", "fairly", "relatively"
    );

    /**
     * Record for pattern matches with metadata
     */
    public record PatternMatch(
        String patternName,
        int lineNumber,
        String matchedText,
        String category
    ) {}

    /**
     * Record for document metrics
     */
    public record DocumentMetrics(
        int totalWords,
        int totalSentences,
        int totalParagraphs,
        Map<String, Integer> patternCounts,
        Map<String, Double> metricValues
    ) {}

    /**
     * Analyze all patterns in text
     */
    public List<PatternMatch> analyzeAllPatterns(String text) {
        List<PatternMatch> allMatches = new ArrayList<>();
        String[] lines = text.split("\\R?");

        allMatches.addAll(analyzeTransitions(text, lines));
        allMatches.addAll(analyzeHedging(text, lines));
        allMatches.addAll(analyzeTeachingTone(text, lines));
        allMatches.addAll(analyzeFormulaicOpenings(text, lines));
        allMatches.addAll(analyzePassiveVoice(text, lines));
        allMatches.addAll(analyzeAbstractNouns(text, lines));
        allMatches.addAll(analyzeFalseBalance(text, lines));
        allMatches.addAll(analyzeSummaryInflation(text, lines));
        allMatches.addAll(analyzeOverExplanation(text, lines));

        return allMatches;
    }

    /**
     * Analyze transition stacking patterns
     */
    public List<PatternMatch> analyzeTransitions(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = TRANSITION_STACKING.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Transition Stacking",
                lineNumber,
                matcher.group().trim(),
                "Structural"
            ));
        }

        return matches;
    }

    /**
     * Analyze hedging stacking patterns
     */
    public List<PatternMatch> analyzeHedging(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = HEDGE_STACKING.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Hedging Stacking",
                lineNumber,
                matcher.group().trim(),
                "Lexical"
            ));
        }

        return matches;
    }

    /**
     * Analyze teaching tone patterns
     */
    public List<PatternMatch> analyzeTeachingTone(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = TEACHING_TONE.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Teaching Tone",
                lineNumber,
                matcher.group().trim(),
                "Rhetorical"
            ));
        }

        return matches;
    }

    /**
     * Analyze formulaic opening patterns
     */
    public List<PatternMatch> analyzeFormulaicOpenings(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = FORMULAIC_OPENING.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Formulaic Opening",
                lineNumber,
                matcher.group().trim(),
                "Structural"
            ));
        }

        return matches;
    }

    /**
     * Analyze passive voice patterns
     */
    public List<PatternMatch> analyzePassiveVoice(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = PASSIVE_VOICE.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Passive Voice",
                lineNumber,
                matcher.group().trim(),
                "Syntactic"
            ));
        }

        return matches;
    }

    /**
     * Analyze abstract noun chain patterns
     */
    public List<PatternMatch> analyzeAbstractNouns(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = ABSTRACT_NOUN_CHAIN.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Abstract Noun Chain",
                lineNumber,
                matcher.group().trim(),
                "Lexical"
            ));
        }

        return matches;
    }

    /**
     * Analyze false balance patterns
     */
    public List<PatternMatch> analyzeFalseBalance(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = FALSE_BALANCE.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "False Balance Construction",
                lineNumber,
                matcher.group().trim(),
                "Rhetorical"
            ));
        }

        return matches;
    }

    /**
     * Analyze summary inflation patterns
     */
    public List<PatternMatch> analyzeSummaryInflation(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = SUMMARY_INFLATION.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Summary Inflation",
                lineNumber,
                matcher.group().trim(),
                "Rhetorical"
            ));
        }

        return matches;
    }

    /**
     * Analyze over-explanation patterns
     */
    public List<PatternMatch> analyzeOverExplanation(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();
        Matcher matcher = OVER_EXPLANATION.matcher(text);

        while (matcher.find()) {
            int lineNumber = findLineNumber(text, matcher.start(), lines);
            matches.add(new PatternMatch(
                "Over-Explanation",
                lineNumber,
                matcher.group().trim(),
                "Rhetorical"
            ));
        }

        return matches;
    }

    /**
     * Calculate document metrics
     */
    public DocumentMetrics calculateMetrics(String text, List<PatternMatch> matches) {
        String[] words = text.split("\\s+");
        String[] sentences = text.split("[.!?]+");
        String[] paragraphs = text.split("\\R?\\R?");

        int totalWords = words.length;
        int totalSentences = sentences.length;
        int totalParagraphs = paragraphs.length;

        Map<String, Integer> patternCounts = matches.stream()
            .collect(Collectors.groupingBy(
                PatternMatch::patternName,
                Collectors.collectingAndThen(Collectors.counting(), Math::toIntExact)
            ));

        Map<String, Double> metricValues = new HashMap<>();
        metricValues.put("transitionDensity", calculateTransitionDensity(text));
        metricValues.put("hedgeDensity", calculateHedgeDensity(text));
        metricValues.put("abstractNounRatio", calculateAbstractNounRatio(text));
        metricValues.put("passiveVoiceRate", calculatePassiveVoiceRate(text, sentences));
        metricValues.put("sentenceLengthVariance", calculateSentenceLengthVariance(sentences));
        metricValues.put("vocabularyDiversity", calculateVocabularyDiversity(text));
        metricValues.put("teachingToneDensity", calculateTeachingToneDensity(text));

        return new DocumentMetrics(
            totalWords,
            totalSentences,
            totalParagraphs,
            patternCounts,
            metricValues
        );
    }

    /**
     * Calculate transition density (per 1000 words)
     */
    public double calculateTransitionDensity(String text) {
        String[] words = text.toLowerCase().split("\\s+");
        long transitionCount = Arrays.stream(words)
            .filter(TRANSITION_WORDS::contains)
            .count();
        return words.length > 0 ? (transitionCount * 1000.0) / words.length : 0.0;
    }

    /**
     * Calculate hedge density (per 100 words)
     */
    public double calculateHedgeDensity(String text) {
        String[] words = text.toLowerCase().split("\\s+");
        long hedgeCount = Arrays.stream(words)
            .filter(HEDGING_WORDS::contains)
            .count();
        return words.length > 0 ? (hedgeCount * 100.0) / words.length : 0.0;
    }

    /**
     * Calculate abstract noun ratio
     */
    public double calculateAbstractNounRatio(String text) {
        String[] words = text.toLowerCase().split("\\s+");
        long abstractCount = Arrays.stream(words)
            .filter(ABSTRACT_NOUNS::contains)
            .count();
        long nounCount = Arrays.stream(words)
            .filter(w -> w.endsWith("tion") || w.endsWith("ment") || w.endsWith("ness") || w.endsWith("ity"))
            .count();
        return nounCount > 0 ? (double) abstractCount / nounCount : 0.0;
    }

    /**
     * Calculate passive voice rate (percentage of sentences)
     */
    public double calculatePassiveVoiceRate(String text, String[] sentences) {
        int passiveCount = 0;
        Matcher matcher = PASSIVE_VOICE.matcher(text);

        for (String sentence : sentences) {
            if (matcher.reset(sentence).find()) {
                passiveCount++;
            }
        }

        return sentences.length > 0 ? (passiveCount * 100.0) / sentences.length : 0.0;
    }

    /**
     * Calculate sentence length variance
     */
    public double calculateSentenceLengthVariance(String[] sentences) {
        double[] lengths = Arrays.stream(sentences)
            .map(s -> s.split("\\s+").length)
            .filter(l -> l > 0)
            .mapToDouble(Integer::doubleValue)
            .toArray();

        if (lengths.length == 0) return 0.0;

        double mean = Arrays.stream(lengths).average().orElse(0);
        return Arrays.stream(lengths)
            .map(l -> Math.pow(l - mean, 2))
            .average()
            .orElse(0);
    }

    /**
     * Calculate vocabulary diversity (type-token ratio)
     */
    public double calculateVocabularyDiversity(String text) {
        String[] words = text.toLowerCase().split("[^a-zA-Z]+");
        if (words.length == 0) return 0.0;

        Set<String> uniqueWords = new HashSet<>(Arrays.asList(words));
        return (double) uniqueWords.size() / words.length;
    }

    /**
     * Calculate teaching tone density (per 1000 words)
     */
    public double calculateTeachingToneDensity(String text) {
        String[] words = text.split("\\s+");
        Matcher matcher = TEACHING_TONE.matcher(text);
        int toneCount = 0;

        while (matcher.find()) {
            toneCount++;
        }

        return words.length > 0 ? (toneCount * 1000.0) / words.length : 0.0;
    }

    /**
     * Find line number for character position
     */
    private int findLineNumber(String text, int position, String[] lines) {
        int lineNum = 1;
        int currentPos = 0;

        for (String line : lines) {
            if (currentPos + line.length() >= position) {
                return lineNum;
            }
            currentPos += line.length() + 1; // +1 for newline
            lineNum++;
        }

        return lineNum;
    }

    /**
     * Generate comprehensive analysis report
     */
    public String generateReport(List<PatternMatch> matches, DocumentMetrics metrics, String domain) {
        StringBuilder report = new StringBuilder();

        report.append("# AI-Style Pattern Analysis Report\\n\\n");
        report.append("## Document Information\\n");
        report.append("- **Total Words**: ").append(metrics.totalWords()).append("\\n");
        report.append("- **Total Sentences**: ").append(metrics.totalSentences()).append("\\n");
        report.append("- **Total Paragraphs**: ").append(metrics.totalParagraphs()).append("\\n");
        report.append("- **Domain**: ").append(domain != null ? domain : "general").append("\\n\\n");

        // Categorize findings
        Map<String, List<PatternMatch>> byCategory = matches.stream()
            .collect(Collectors.groupingBy(PatternMatch::category));

        report.append("## Pattern Findings by Category\\n\\n");

        for (String category : Arrays.asList("Structural", "Lexical", "Syntactic", "Rhetorical")) {
            List<PatternMatch> categoryMatches = byCategory.getOrDefault(category, List.of());
            if (!categoryMatches.isEmpty()) {
                report.append("### ").append(category).append(" Patterns\\n\\n");

                for (PatternMatch match : categoryMatches) {
                    report.append("- **Line ").append(match.lineNumber()).append("**: ").append(match.patternName()).append("\\n");
                    report.append("  - **Matched Text**: \"").append(match.matchedText()).append("\"\\n");
                }
                report.append("\\n");
            }
        }

        // Pattern counts
        report.append("## Pattern Counts\\n\\n");
        metrics.patternCounts().entrySet().stream()
            .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
            .forEach(entry -> report.append("- ").append(entry.getKey())
                          .append(": ").append(entry.getValue()).append("\\n"));
        report.append("\\n");

        // Quantitative metrics
        report.append("## Quantitative Metrics\\n\\n");
        report.append("### Structural Metrics\\n");
        report.append("- **Transition Density**: ").append(String.format("%.2f", metrics.metricValues().get("transitionDensity")))
              .append(" per 1000 words\\n");
        report.append("\\n");

        report.append("### Lexical Metrics\\n");
        report.append("- **Hedge Density**: ").append(String.format("%.2f", metrics.metricValues().get("hedgeDensity")))
              .append(" per 100 words\\n");
        report.append("- **Abstract Noun Ratio**: ").append(String.format("%.2f", metrics.metricValues().get("abstractNounRatio")))
              .append("\\n");
        report.append("- **Vocabulary Diversity**: ").append(String.format("%.3f", metrics.metricValues().get("vocabularyDiversity")))
              .append("\\n\\n");

        report.append("### Syntactic Metrics\\n");
        report.append("- **Passive Voice Rate**: ").append(String.format("%.1f", metrics.metricValues().get("passiveVoiceRate")))
              .append("%\\n");
        report.append("- **Sentence Length Variance**: ").append(String.format("%.2f", metrics.metricValues().get("sentenceLengthVariance")))
              .append(" words\\n\\n");

        report.append("### Rhetorical Metrics\\n");
        report.append("- **Teaching Tone Density**: ").append(String.format("%.2f", metrics.metricValues().get("teachingToneDensity")))
              .append(" per 1000 words\\n\\n");

        // Summary
        report.append("## Summary\\n");
        report.append("- **Total Findings**: ").append(matches.size()).append("\\n");
        report.append("- **Categories Affected**: ").append(byCategory.size()).append("\\n");

        if (!matches.isEmpty()) {
            String mostCommon = metrics.patternCounts().entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElse("N/A");
            report.append("- **Most Common Pattern**: ").append(mostCommon).append("\\n");
        } else {
            report.append("- **Most Common Pattern**: N/A (no findings)\\n");
        }

        report.append("\\n---\\n\\n");
        report.append("**Note**: This analysis identifies prose patterns that may affect naturalness and readability.\\n");
        report.append("Findings are based on stylometric analysis, not authorship determination.\\n");
        report.append("Domain-appropriate patterns should be identified and preserved.\\n");

        return report.toString();
    }

    /**
     * Main method for CLI usage
     */
    public static void main(String[] args) {
        if (args.length == 0) {
            System.err.println("Usage: java ProsePatternAnalyzer <file> [domain]");
            System.err.println("  file: Path to text file to analyze");
            System.err.println("  domain: Optional domain (medical, academic, technical, educational, professional)");
            System.exit(1);
        }

        String filePath = args[0];
        String domain = args.length > 1 ? args[1] : "general";

        try {
            String text = Files.readString(Path.of(filePath));
            ProsePatternAnalyzer analyzer = new ProsePatternAnalyzer();

            List<PatternMatch> findings = analyzer.analyzeAllPatterns(text);
            DocumentMetrics metrics = analyzer.calculateMetrics(text, findings);

            String report = analyzer.generateReport(findings, metrics, domain);
            System.out.println(report);

        } catch (IOException e) {
            System.err.println("Error reading file: " + e.getMessage());
            System.exit(1);
        }
    }
}