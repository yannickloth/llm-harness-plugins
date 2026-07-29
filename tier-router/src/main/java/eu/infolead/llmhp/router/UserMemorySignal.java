package eu.infolead.llmhp.router;

enum Signal { LEARNING, EXPERT, PREFERENCE }

record UserMemorySignal(String domain, Signal signal, String source) {
    String key() { return domain.toLowerCase() + ":" + signal.name().toLowerCase(); }
}
