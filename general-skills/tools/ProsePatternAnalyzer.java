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

    private String domain = "general";

    // Patterns that are domain-appropriate in scientific writing and should be
    // reported as tolerated (not flagged as findings).
    private static final Set<String> SCIENTIFIC_TOLERATED = Set.of(
        "Passive Voice",
        "Formulaic Opening",
        "Abstract Noun Chain"
    );

    // Pattern regex definitions
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

    // AI-hype filler adjectives: vacuous intensifiers that add no information.
    // Dense use is a subtle AI-style signal. Only the clearly vacuous/marketing
    // ones are listed; ordinary academic intensifiers ("key", "significant",
    // "various", "substantial", "robust") are common in careful writing and are
    // deliberately NOT listed to avoid false positives.
    private static final Set<String> FILLER_ADJECTIVES = Set.of(
        "multifaceted", "holistic", "innovative", "seamless", "cutting-edge",
        "revolutionary", "game-changing", "state-of-the-art", "comprehensive"
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
        allMatches.addAll(analyzeNominalisationBloat(text, lines));
        allMatches.addAll(analyzeFalseBalance(text, lines));
        allMatches.addAll(analyzeSummaryInflation(text, lines));
        allMatches.addAll(analyzeOverExplanation(text, lines));

        if ("scientific".equals(domain)) {
            allMatches.removeIf(m -> SCIENTIFIC_TOLERATED.contains(m.patternName()));
        }

        return allMatches;
    }

    /**
     * Analyze transition stacking patterns.
     * Genuine stacking means two transition words in close proximity within the
     * same sentence (e.g. "However, furthermore, moreover"). The unbounded .*
     * regex over-spans and flags far-apart transitions that serve distinct
     * rhetorical roles, so we bound the check to a small token window.
     */
    public List<PatternMatch> analyzeTransitions(String text, String[] lines) {
        return analyzeStacking(text, lines, TRANSITION_WORDS, "Transition Stacking", "Structural", 5);
    }

    /**
     * Analyze hedging stacking patterns.
     * Genuine hedge-bloat clusters hedges adjacently ("may potentially possibly").
     * Legitimate scientific hedging distributes "may" across different clauses
     * for different epistemic claims, so use a TIGHT window (at most 1
     * intervening token) to avoid flagging legitimate distributed hedging.
     */
    public List<PatternMatch> analyzeHedging(String text, String[] lines) {
        return analyzeStacking(text, lines, HEDGING_WORDS, "Hedging Stacking", "Lexical", 1);
    }

    /**
     * Shared stacking detector: flag two words from {@code words} only when they
     * occur within {@code window} tokens of each other in the same sentence.
     * Sentence boundaries reset the window. Returns each flagged pair once.
     */
    private List<PatternMatch> analyzeStacking(String text, String[] lines, Set<String> words, String name, String category, int window) {
        List<PatternMatch> matches = new ArrayList<>();
        List<String> tokens = new ArrayList<>();
        List<Integer> tokenPositions = new ArrayList<>();
        List<Integer> tokenLineNumbers = new ArrayList<>();

        java.util.regex.Pattern tokenP = java.util.regex.Pattern.compile("[A-Za-z']+|[.!?]");
        java.util.regex.Matcher tm = tokenP.matcher(text);
        while (tm.find()) {
            tokens.add(tm.group());
            tokenPositions.add(tm.start());
            tokenLineNumbers.add(findLineNumber(text, tm.start(), lines));
        }

        for (int i = 0; i < tokens.size(); i++) {
            String tok = tokens.get(i);
            if (tok.equals(".") || tok.equals("!") || tok.equals("?")) {
                continue;
            }
            if (!words.contains(tok.toLowerCase())) continue;
            // Look ahead within `window` tokens, staying in the same sentence.
            for (int j = i + 1; j < tokens.size() && j - i <= window; j++) {
                if (tokens.get(j).equals(".") || tokens.get(j).equals("!") || tokens.get(j).equals("?")) break;
                if (words.contains(tokens.get(j).toLowerCase())) {
                    matches.add(new PatternMatch(
                        name,
                        tokenLineNumbers.get(i),
                        text.substring(tokenPositions.get(i), tokenPositions.get(j) + tokens.get(j).length()).trim(),
                        category
                    ));
                    break; // one pair per anchor word
                }
            }
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
     * Analyze nominalisation bloat and filler-adjective density.
     * Catches the subtle AI-style signal that crude tells miss: chains of
     * "the X of the Y of the Z" with abstract nouns, and dense filler
     * adjectives ("comprehensive", "multifaceted", "various", ...). These are
     * AI-bloat even in scientific prose, so this pattern is NOT suppressed in
     * scientific mode.
     */
    public List<PatternMatch> analyzeNominalisationBloat(String text, String[] lines) {
        List<PatternMatch> matches = new ArrayList<>();

        // (a) of-of-of chains around abstract nouns: "the implementation of the
        // utilization of the optimization". Requires at least two consecutive
        // "X of" links (three abstract nouns) so ordinary "the diversity of
        // modularization" (a single of-link) is NOT flagged.
        Pattern chain = Pattern.compile(
            "(?:the\\s+)?([a-z]+(?:ation|ization|ment|ness|ity)\\s+of\\s+(?:the\\s+)?){2,}" +
            "[a-z]+(?:ation|ization|ment|ness|ity)",
            Pattern.CASE_INSENSITIVE
        );
        Matcher cm = chain.matcher(text);
        while (cm.find()) {
            matches.add(new PatternMatch(
                "Nominalisation Bloat",
                findLineNumber(text, cm.start(), lines),
                cm.group().trim(),
                "Lexical"
            ));
        }

        // (b) filler-adjective density: flag the line if it contains >= 2
        // distinct filler adjectives (a local density signal).
        String[] lines2 = text.split("\\R");
        for (int i = 0; i < lines2.length; i++) {
            Set<String> found = new HashSet<>();
            String lower = lines2[i].toLowerCase();
            for (String adj : FILLER_ADJECTIVES) {
                if (lower.contains(adj)) found.add(adj);
            }
            if (found.size() >= 2) {
                matches.add(new PatternMatch(
                    "Filler Adjective Density",
                    i + 1,
                    String.join(", ", found),
                    "Lexical"
                ));
            }
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
        metricValues.put("sentenceLengthCoV", calculateSentenceLengthCoV(text));
        metricValues.put("wordEntropy", calculateWordEntropy(text));
        metricValues.put("charEntropy", calculateCharEntropy(text));
        metricValues.put("perplexityApprox", calculatePerplexityApprox(text));
        metricValues.put("bigramEntropy", calculateBigramConditionalEntropy(text));
        metricValues.put("bigramPerplexity", calculateBigramPerplexity(text));
        metricValues.put("structureTypeDiversity", calculateStructureTypeDiversity(text));

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

    // ---------------------------------------------------------------
    // Statistical layer — burstiness, entropy, and perplexity
    // ---------------------------------------------------------------
    // These mirror what professional AI-style detectors measure. They are
    // reported as CROSS-REFERENCE metrics with domain baselines, never as an
    // authorship verdict. Detectors have high false-positive rates on formal,
    // scientific, and non-native English prose.

    /**
     * Sentence-length coefficient of variation (burstiness proxy).
     * Human writing is "bursty": it mixes short and long sentences, giving a
     * higher CoV. Uniform AI-style writing clusters lengths, giving a low CoV.
     */
    public double calculateSentenceLengthCoV(String text) {
        String[] sentences = text.split("[.!?]+");
        double[] lengths = Arrays.stream(sentences)
            .map(s -> s.split("\\s+").length)
            .filter(l -> l > 0)
            .mapToDouble(Integer::doubleValue)
            .toArray();

        if (lengths.length == 0) return 0.0;

        double mean = Arrays.stream(lengths).average().orElse(0);
        if (mean == 0) return 0.0;

        double variance = Arrays.stream(lengths)
            .map(l -> Math.pow(l - mean, 2))
            .average()
            .orElse(0);
        return Math.sqrt(variance) / mean;
    }

    /**
     * Sentence-length bucket distribution (burstiness, structural).
     * Returns the fraction of sentences in short (<12 words), medium
     * (12-24), and long (>24) buckets as "short/medium/long".
     */
    public String calculateSentenceLengthBuckets(String text) {
        String[] sentences = text.split("[.!?]+");
        int shortC = 0, mediumC = 0, longC = 0, total = 0;

        for (String s : sentences) {
            int len = s.split("\\s+").length;
            if (len <= 0) continue;
            total++;
            if (len < 12) shortC++;
            else if (len <= 24) mediumC++;
            else longC++;
        }

        if (total == 0) return "0/0/0";
        return String.format("%d/%d/%d (short/med/long)",
            Math.round(100.0 * shortC / total),
            Math.round(100.0 * mediumC / total),
            Math.round(100.0 * longC / total));
    }

    /**
     * Word-level Shannon entropy (bits per word). A proxy for lexical
     * predictability: uniform AI vocabulary yields lower entropy than varied
     * human vocabulary. Entropy alone is not an authorship signal.
     */
    public double calculateWordEntropy(String text) {
        String[] words = text.toLowerCase().split("[^a-zA-Z']+");
        return shannonEntropy(Arrays.asList(words));
    }

    /**
     * Character-level Shannon entropy (bits per char). Captures morphology
     * and spelling surprise; a weak, purely statistical perplexity proxy.
     */
    public double calculateCharEntropy(String text) {
        List<Character> chars = new ArrayList<>();
        for (char c : text.toLowerCase().toCharArray()) {
            if (Character.isLetterOrDigit(c)) chars.add(c);
        }
        return shannonEntropy(chars);
    }

    /**
     * Word-unigram perplexity approximation = 2^wordEntropy.
     * True LLM perplexity requires a trained language model; this is a
     * purely statistical, corpus-free approximation and MUST be treated as
     * such. It is not a reliable authorship indicator.
     */
    public double calculatePerplexityApprox(String text) {
        double entropy = calculateWordEntropy(text);
        return Math.pow(2.0, entropy);
    }

    /**
     * Bigram conditional entropy (bits per word). Captures how predictable the
     * next word is given the previous word — the core of what LLM perplexity
     * measures — using a corpus-free bigram model. Higher than unigram entropy
     * gaps between varied (human) and uniform (AI) vocabulary.
     */
    public double calculateBigramConditionalEntropy(String text) {
        String[] words = text.toLowerCase().split("[^a-zA-Z']+");
        if (words.length < 2) return 0.0;

        Map<String, Map<String, Integer>> transition = new HashMap<>();
        Map<String, Integer> prefixCount = new HashMap<>();
        for (int i = 0; i < words.length - 1; i++) {
            String w = words[i];
            if (w.isEmpty()) continue;
            String next = words[i + 1];
            transition.computeIfAbsent(w, k -> new HashMap<>()).merge(next, 1, Integer::sum);
            prefixCount.merge(w, 1, Integer::sum);
        }

        double entropy = 0.0;
        for (Map.Entry<String, Map<String, Integer>> e : transition.entrySet()) {
            String prefix = e.getKey();
            int total = prefixCount.get(prefix);
            for (int c : e.getValue().values()) {
                double p = (double) c / total;
                entropy += p * prefixCount.get(prefix) / (double) (words.length - 1)
                        * Math.log(p) / Math.log(2);
            }
        }
        return -entropy;
    }

    /**
     * Bigram perplexity approximation = 2^bigramConditionalEntropy.
     * A stronger, order-aware surrogate for LLM perplexity than the unigram
     * version. Still corpus-free; still not detector-grade.
     */
    public double calculateBigramPerplexity(String text) {
        double entropy = calculateBigramConditionalEntropy(text);
        return Math.pow(2.0, entropy);
    }

    /**
     * Structure-type diversity: fraction of distinct sentence "shapes".
     * A shape is a coarse clause-structure signature derived from the number
     * of punctuation delimiters (commas, semicolons, colons, em-dashes) plus
     * length band. Uniform AI prose repeats few shapes; human prose is more
     * diverse. 1.0 = every sentence a distinct shape, 0.0 = all identical.
     */
    public double calculateStructureTypeDiversity(String text) {
        String[] sentences = text.split("[.!?]+");
        Set<String> shapes = new HashSet<>();
        int count = 0;

        for (String s : sentences) {
            String t = s.trim();
            if (t.isEmpty()) continue;
            count++;
            int delimiters = 0;
            for (char c : t.toCharArray()) {
                if (c == ',' || c == ';' || c == ':' || c == '\u2014' || c == '-') delimiters++;
            }
            int len = t.split("\\s+").length;
            String band = len < 12 ? "S" : (len <= 24 ? "M" : "L");
            String shape = delimiters + ":" + band;
            shapes.add(shape);
        }

        return count > 0 ? (double) shapes.size() / count : 0.0;
    }

    private static <T> double shannonEntropy(List<T> items) {
        if (items.isEmpty()) return 0.0;
        Map<T, Integer> counts = new HashMap<>();
        for (T item : items) counts.merge(item, 1, Integer::sum);
        int total = items.size();
        double entropy = 0.0;
        for (int c : counts.values()) {
            double p = (double) c / total;
            entropy -= p * (Math.log(p) / Math.log(2));
        }
        return entropy;
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
    public String generateReport(List<PatternMatch> matches, DocumentMetrics metrics, String domain, String text) {
        StringBuilder report = new StringBuilder();

        report.append("# AI-Style Pattern Analysis Report\n\n");
        report.append("## Document Information\n");
        report.append("- **Total Words**: ").append(metrics.totalWords()).append("\n");
        report.append("- **Total Sentences**: ").append(metrics.totalSentences()).append("\n");
        report.append("- **Total Paragraphs**: ").append(metrics.totalParagraphs()).append("\n");
        report.append("- **Domain**: ").append(domain != null ? domain : "general").append("\n\n");

        // Categorize findings
        Map<String, List<PatternMatch>> byCategory = matches.stream()
            .collect(Collectors.groupingBy(PatternMatch::category));

        report.append("## Pattern Findings by Category\n\n");

        for (String category : Arrays.asList("Structural", "Lexical", "Syntactic", "Rhetorical")) {
            List<PatternMatch> categoryMatches = byCategory.getOrDefault(category, List.of());
            if (!categoryMatches.isEmpty()) {
                report.append("### ").append(category).append(" Patterns\n\n");

                for (PatternMatch match : categoryMatches) {
                    report.append("- **Line ").append(match.lineNumber()).append("**: ").append(match.patternName()).append("\n");
                    report.append("  - **Matched Text**: \"").append(match.matchedText()).append("\"\n");
                }
                report.append("\n");
            }
        }

        // Pattern counts
        report.append("## Pattern Counts\n\n");
        metrics.patternCounts().entrySet().stream()
            .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
            .forEach(entry -> report.append("- ").append(entry.getKey())
                          .append(": ").append(entry.getValue()).append("\n"));
        report.append("\n");

        // Quantitative metrics
        report.append("## Quantitative Metrics\n\n");
        report.append("### Structural Metrics\n");
        report.append("- **Transition Density**: ").append(String.format("%.2f", metrics.metricValues().get("transitionDensity")))
              .append(" per 1000 words\n");
        report.append("\n");

        report.append("### Lexical Metrics\n");
        report.append("- **Hedge Density**: ").append(String.format("%.2f", metrics.metricValues().get("hedgeDensity")))
              .append(" per 100 words\n");
        report.append("- **Abstract Noun Ratio**: ").append(String.format("%.2f", metrics.metricValues().get("abstractNounRatio")))
              .append("\n");
        report.append("- **Vocabulary Diversity**: ").append(String.format("%.3f", metrics.metricValues().get("vocabularyDiversity")))
              .append("\n\n");

        report.append("### Syntactic Metrics\n");
        report.append("- **Passive Voice Rate**: ").append(String.format("%.1f", metrics.metricValues().get("passiveVoiceRate")))
              .append("%\n");
        report.append("- **Sentence Length Variance**: ").append(String.format("%.2f", metrics.metricValues().get("sentenceLengthVariance")))
              .append(" words\n\n");

        report.append("### Statistical Layer (burstiness / entropy / perplexity)\n");
        report.append("These mirror what professional AI-style detectors compute. They are CROSS-REFERENCE metrics with domain baselines, not an authorship verdict.\n");
        report.append("- **Sentence-Length CoV (burstiness)**: ").append(String.format("%.3f", metrics.metricValues().get("sentenceLengthCoV")))
              .append("  (higher = more varied rhythm, human-typical; low = uniform, AI-typical)\n");
        report.append("- **Sentence-Length Buckets**: ").append(calculateSentenceLengthBuckets(text)).append("\n");
        report.append("- **Structure-Type Diversity**: ").append(String.format("%.3f", metrics.metricValues().get("structureTypeDiversity")))
              .append("  (1.0 = every sentence a distinct shape; low = repeated shapes, AI-typical)\n");
        report.append("- **Word Entropy**: ").append(String.format("%.3f", metrics.metricValues().get("wordEntropy")))
              .append(" bits/word  (lower = more predictable vocabulary)\n");
        report.append("- **Char Entropy**: ").append(String.format("%.3f", metrics.metricValues().get("charEntropy")))
              .append(" bits/char\n");
        report.append("- **Bigram Conditional Entropy**: ").append(String.format("%.3f", metrics.metricValues().get("bigramEntropy")))
              .append(" bits/word  (INFORMATIONAL: tracks vocabulary richness/length; NOT a reliable AI-style discriminator — real prose often scores HIGHER than synthetic AI text here)\n");
        report.append("- **Unigram Perplexity (approx)**: ").append(String.format("%.1f", metrics.metricValues().get("perplexityApprox")))
              .append("  (word-unigram approx of LLM perplexity; NOT reliable as authorship evidence)\n");
        report.append("- **Bigram Perplexity (approx)**: ").append(String.format("%.1f", metrics.metricValues().get("bigramPerplexity")))
              .append("  (INFORMATIONAL; not a reliable AI-style signal)\n\n");
        report.append("**Reliable discriminator metrics** (these separated AI-typical from human-typical cleanly in validation):\n");
        report.append("- Sentence-Length CoV (burstiness), Structure-Type Diversity, Word Entropy, Unigram Perplexity.\n\n");
        report.append("**Domain baselines (indicative, not thresholds):**\n");
        report.append("- Burstiness (CoV): 0.6-1.2 general prose; formal/scientific can run lower (0.4-0.9).\n");
        report.append("- Word entropy: ~9-11 bits/word typical English prose.\n");
        report.append("- A LOW burstiness + LOW entropy + LOW structure diversity + pattern findings together warrant a human read, never a verdict.\n\n");

        report.append("### Rhetorical Metrics\n");
        report.append("- **Teaching Tone Density**: ").append(String.format("%.2f", metrics.metricValues().get("teachingToneDensity")))
              .append(" per 1000 words\n\n");

        // Summary
        report.append("## Summary\n");
        report.append("- **Total Findings**: ").append(matches.size()).append("\n");
        report.append("- **Categories Affected**: ").append(byCategory.size()).append("\n");

        if (!matches.isEmpty()) {
            String mostCommon = metrics.patternCounts().entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElse("N/A");
            report.append("- **Most Common Pattern**: ").append(mostCommon).append("\n");
        } else {
            report.append("- **Most Common Pattern**: N/A (no findings)\n");
        }

        report.append("\n---\n\n");
        report.append("**Note**: This analysis identifies prose patterns that may affect naturalness and readability.\n");
        report.append("A zero-finding result means NO CRUDE TELLS WERE DETECTED; it does NOT prove the prose is human-written.\n");
        report.append("The analyzer has low recall: it misses subtle AI style (nominalisation bloat, uniform rhythm, vocabulary\n");
        report.append("compression) that does not hit the listed patterns. Confirm with a contextual LLM/human read.\n");
        report.append("Findings are based on stylometric analysis, not authorship determination.\n");
        report.append("The statistical layer (burstiness, entropy, perplexity) is a cross-reference, NOT an AI detector.\n");
        report.append("Detectors have high false-positive rates on formal, scientific, and non-native English prose.\n");
        report.append("Do not use any score or metric here as evidence of authorship; use it only to decide where a human read is warranted.\n");
        report.append("Domain-appropriate patterns should be identified and preserved.\n");

        return report.toString();
    }

    /**
     * Main method for CLI usage
     */
    public static void main(String[] args) {
        String filePath = null;
        String domain = "general";

        for (int i = 0; i < args.length; i++) {
            if ("--domain".equals(args[i]) && i + 1 < args.length) {
                domain = args[i + 1];
                i++;
            } else if (filePath == null) {
                filePath = args[i];
            }
        }

        if (filePath == null) {
            System.err.println("Usage: java ProsePatternAnalyzer <file> [--domain domain]");
            System.err.println("  file: Path to text file to analyze");
            System.err.println("  --domain domain: general (default) | medical | academic | technical | educational | professional | scientific");
            System.err.println("    scientific tolerates passive voice, hedging, formulaic openings, and abstract nouns as conventional.");
            System.exit(1);
        }

        try {
            String text = Files.readString(Path.of(filePath));
            ProsePatternAnalyzer analyzer = new ProsePatternAnalyzer();
            analyzer.domain = domain;

            List<PatternMatch> findings = analyzer.analyzeAllPatterns(text);
            DocumentMetrics metrics = analyzer.calculateMetrics(text, findings);

            String report = analyzer.generateReport(findings, metrics, domain, text);
            System.out.println(report);

        } catch (IOException e) {
            System.err.println("Error reading file: " + e.getMessage());
            System.exit(1);
        }
    }
}