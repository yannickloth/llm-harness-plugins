# Corpus Analysis Framework for AI Prose Patterns

## Analysis Protocol

### Sample Selection Criteria

**Document Types to Analyze:**
1. **Academic/Research Papers**: Abstracts, introductions, methodology sections
2. **Technical Documentation**: User guides, API docs, specifications
3. **Educational Content**: Tutorials, textbooks, course materials
4. **Professional Writing**: Reports, white papers, case studies
5. **Domain-Specific**: Medical, scientific, legal, business writing

**Sample Size**: 10-20 documents per category for baseline establishment

### Analysis Metrics

#### Structural Metrics
- **Transition Density**: Transitions per 100 words
- **Paragraph Length Variance**: Standard deviation of paragraph word counts
- **Structural Template Repetition**: % of paragraphs following identical patterns
- **Opening/Closing Formulaic Rate**: % of paragraphs with formulaic beginnings/endings

#### Lexical Metrics
- **Hedge Density**: Uncertainty markers per 100 words
- **Abstract Noun Ratio**: Abstract nouns / total nouns
- **Vocabulary Diversity**: Type-token ratio, MTLD (Measure of Textual Lexical Diversity)
- **Jargon Frequency**: Domain-specific vs. general vocabulary ratio

#### Syntactic Metrics
- **Passive Voice Rate**: Passive constructions per 100 sentences
- **Sentence Length Distribution**: Mean, median, standard deviation
- **Syntactic Complexity**: Subordinate clause density per sentence
- **Punctuation Patterns**: Comma/semicolon frequency per 100 words

#### Rhetorical Metrics
- **Balance Construction Rate**: "On the other hand" constructions per 1000 words
- **Explanation Redundancy**: % of sentences that repeat previous information
- **Meta-Commentary Density**: "It is worth noting" etc. per 1000 words
- **Teaching Tone Markers**: "Let's explore" etc. per 1000 words

### Baseline Establishment Process

#### Step 1: Human-Written Baseline
1. Select confirmed human-written samples in each domain
2. Calculate all metrics for each sample
3. Establish range (min, max, mean, std dev) per metric per domain
4. Document domain-specific expectations (e.g., academic writing tolerates more hedging)

#### Step 2: Known AI-Generated Samples
1. Analyze AI-generated text in same domains
2. Compare metrics against human baseline
3. Identify metrics with significant deviation (p < 0.05)
4. Establish pattern clusters that co-occur in AI writing

#### Step 3: Gray Zone Analysis
1. Identify samples where metrics are ambiguous
2. Analyze context and domain conventions
3. Determine which deviations are domain-appropriate
4. Document exception rules for each domain

### Analysis Categories

#### Category 1: Structural Analysis
**Questions to Answer:**
- What is natural transition density in this domain?
- How much paragraph structure variation is normal?
- Are formulaic openings/endings conventional here?
- What is acceptable parallelism frequency?

**Domain Baselines:**
- **Academic**: Higher transition density, formulaic abstract structures
- **Technical**: Moderate transitions, uniform paragraph structure acceptable
- **Educational**: Varying transitions, some formulaic scaffolding
- **Professional**: Lower transition density, more varied structures

#### Category 2: Lexical Analysis
**Questions to Answer:**
- What hedge density is appropriate for uncertainty claims?
- How much abstract language is domain-conventional?
- What vocabulary richness indicates professional vs. AI writing?
- Which jargon patterns are domain-standard?

**Domain Baselines:**
- **Medical**: High hedge density (appropriate uncertainty), medical jargon standard
- **Academic**: Moderate hedging, abstract nouns conceptually necessary
- **Technical**: Low hedging (precision), technical jargon expected
- **Business**: Moderate hedging, business jargon varies by subfield

#### Category 3: Syntactic Analysis
**Questions to Answer:**
- What passive voice frequency is conventional?
- How should sentence length vary naturally?
- What syntactic complexity is appropriate for audience?
- Are punctuation patterns standardized by style guides?

**Domain Baselines:**
- **Scientific**: Higher passive voice (convention), complex sentences acceptable
- **Technical**: Moderate passive voice, uniform sentence length for clarity
- **Educational**: Lower passive voice, varying sentence length for engagement
- **Professional**: Mixed voice, varied sentence structure

#### Category 4: Rhetorical Analysis
**Questions to Answer:**
- When is false balance actually inappropriate?
- What explanation depth matches audience knowledge?
- Is teaching tone appropriate for this document type?
- How much summarization is redundant vs. valuable?

**Domain Baselines:**
- **Research**: Genuine balance required, specialist audience (low explanation)
- **Technical**: Minimal balance, intermediate audience (moderate explanation)
- **Educational**: Minimal false balance, scaffolding audience (high explanation)
- **Professional**: Context-dependent balance, mixed audiences (varied explanation)

### Severity Calculation Framework

#### Pattern Scoring

**Frequency Factor:**
- Low (< 1 per 1000 words): ×0.5
- Medium (1-3 per 1000 words): ×1.0
- High (> 3 per 1000 words): ×1.5

**Domain Deviation Factor:**
- Within convention: ×0.5
- Slightly outside convention: ×1.0
- Significantly outside convention: ×1.5

**Context Impact Factor:**
- Low impact (minor readability): ×0.5
- Medium impact (noticeable): ×1.0
- High impact (significantly affects reading): ×1.5

**Severity Score Calculation:**
```
Severity = (Frequency Factor × Domain Deviation × Context Impact) × Base Weight
```

**Base Weights by Category:**
- Structural: 0.8
- Lexical: 1.0
- Syntactic: 0.6
- Rhetorical: 1.2

**Severity Mapping:**
- < 1.0: Suggestion
- 1.0-2.0: Recommendation
- > 2.0: Strong Recommendation

### Java Analysis Tool Specification

#### Tool: ProsePatternAnalyzer.java

**Purpose**: Deterministic analysis of text patterns for AI-style detection

**Core Classes:**

```java
public record PatternMatch(
    String patternName,
    int lineNumber,
    String matchedText,
    double severityScore,
    String category
) {}

public record DocumentMetrics(
    String filePath,
    int totalWords,
    int totalSentences,
    int totalParagraphs,
    Map<String, Integer> patternCounts,
    Map<String, Double> metricValues
) {}

public class ProsePatternAnalyzer {
    // Pattern detection methods
    public List<PatternMatch> analyzeTransitions(String text);
    public List<PatternMatch> analyzeHedging(String text);
    public List<PatternMatch> analyzeAbstractNouns(String text);
    public List<PatternMatch> analyzePassiveVoice(String text);
    public List<PatternMatch> analyzeTeachingTone(String text);
    
    // Metric calculation methods
    public DocumentMetrics calculateMetrics(String text);
    public double calculateSeverityScore(PatternMatch match, DocumentMetrics metrics);
    
    // Reporting methods
    public String generateReport(List<PatternMatch> findings, DocumentMetrics metrics);
    public String generateSuggestion(PatternMatch match, String context);
}
```

**Pattern Regex Definitions:**

```java
// Transition patterns
private static final Pattern TRANSITION_STACKING = 
    Pattern.compile("\\b(however|furthermore|moreover|additionally|consequently)\\b.*" +
                  "\\b(furthermore|moreover|additionally|consequently)\\b", 
                  Pattern.CASE_INSENSITIVE);

// Hedging patterns
private static final Pattern HEDGE_STACKING = 
    Pattern.compile("\\b(might|could|may|possibly|potentially|perhaps)\\b.*" +
                  "\\b(might|could|may|possibly|potentially|perhaps)\\b", 
                  Pattern.CASE_INSENSITIVE);

// Teaching tone patterns
private static final Pattern TEACHING_TONE = 
    Pattern.compile("\\b(let's|let us|it's helpful to|we can see that|" +
                  "it's worth noting|it's important to understand)\\b", 
                  Pattern.CASE_INSENSITIVE);

// Formulaic openings
private static final Pattern FORMULAIC_OPENING = 
    Pattern.compile("^(In conclusion|Furthermore|Additionally|Moreover|" +
                  "It is worth noting|It is important to note)\\b", 
                  Pattern.CASE_INSENSITIVE | Pattern.MULTILINE);

// Passive voice indicators (simplified)
private static final Pattern PASSIVE_VOICE = 
    Pattern.compile("\\b(was|were|is|are|been|being)\\s+\\w+ed\\s+by\\b", 
                  Pattern.CASE_INSENSITIVE);
```

**Metric Calculation Methods:**

```java
public double calculateTransitionDensity(String text) {
    int wordCount = text.split("\\s+").length;
    int transitionCount = analyzeTransitions(text).size();
    return (transitionCount * 1000.0) / wordCount;
}

public double calculateVocabularyDiversity(String text) {
    String[] words = text.toLowerCase().split("\\s+");
    Set<String> uniqueWords = new HashSet<>(Arrays.asList(words));
    return (double) uniqueWords.size() / words.length;
}

public double calculateSentenceLengthVariance(String text) {
    String[] sentences = text.split("[.!?]+");
    double[] lengths = Arrays.stream(sentences)
        .map(s -> s.split("\\s+").length)
        .mapToDouble(Integer::doubleValue)
        .toArray();
    double mean = Arrays.stream(lengths).average().orElse(0);
    return Arrays.stream(lengths)
        .map(l -> Math.pow(l - mean, 2))
        .average().orElse(0);
}
```

**Usage Example:**

```java
public class PatternAnalysisCLI {
    public static void main(String[] args) {
        if (args.length == 0) {
            System.err.println("Usage: java PatternAnalysisCLI <file> [domain]");
            System.exit(1);
        }
        
        String filePath = args[0];
        String domain = args.length > 1 ? args[1] : "general";
        
        try {
            String text = Files.readString(Path.of(filePath));
            ProsePatternAnalyzer analyzer = new ProsePatternAnalyzer();
            
            List<PatternMatch> findings = analyzer.analyzeAllPatterns(text);
            DocumentMetrics metrics = analyzer.calculateMetrics(text);
            
            String report = analyzer.generateReport(findings, metrics, domain);
            System.out.println(report);
            
        } catch (IOException e) {
            System.err.println("Error reading file: " + e.getMessage());
            System.exit(1);
        }
    }
}
```

### Integration with AI-Style Auditor

The Java tool provides:
1. **Deterministic pattern detection** - Regex-based, repeatable
2. **Quantitative metrics** - Objective measurements
3. **Domain-aware scoring** - Context-sensitive severity calculation
4. **Concrete suggestions** - Pattern-specific revision recommendations

The AI-Style Auditor agent uses:
1. **Pattern detection** - From Java tool (deterministic)
2. **Context analysis** - Agent judgment for nuanced cases
3. **Domain expertise** - Agent knowledge of conventions
4. **Natural language revision** - Agent-generated suggestions

This hybrid approach ensures:
- Objective detection (reliable, repeatable)
- Contextual interpretation (nuanced, domain-aware)
- Actionable revisions (specific, implementable)
- Scalable analysis (efficient for large documents)