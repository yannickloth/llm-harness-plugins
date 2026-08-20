package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.OptionalLong;

public final class ConsolidationLock {

    record LockState(long mtimeMs, OptionalLong holderPid, String bootId, boolean locked) {}

    public static void check(Path memDir) throws IOException {
        var state = readLock(memDir);
        var now = System.currentTimeMillis();
        long STALE_MS = 60 * 60 * 1000L;
        if (state.locked() && now - state.mtimeMs() < STALE_MS) System.out.println("LOCKED");
        else System.out.println("FREE");
    }

    public static void acquire(Path memDir) throws IOException {
        acquire(memDir, ProcessHandle.current().pid());
    }

    /**
     * Acquire the consolidation lock, recording {@code ownerPid} as the holder.
     *
     * The owner must be a process that stays alive for the duration of the
     * consolidation. Callers that run the consolidation *after* this process
     * would have exited must pass a long-lived owner (e.g. the plugin's own
     * opencode process PID) rather than letting this CLI record its own PID —
     * a short-lived {@code lock-acquire} subprocess exits immediately after
     * printing ACQUIRED, so its recorded PID is dead by the time a second
     * session checks, the lock is judged free, and two consolidations can run
     * concurrently. The 50ms write+verify below only disambiguates a single
     * contention point; the liveness of {@code ownerPid} is what the cross-host
     * mutual exclusion relies on.
     */
    public static void acquire(Path memDir, long ownerPid) throws IOException {
        var state = readLock(memDir);
        var now = System.currentTimeMillis();
        long STALE_MS = 60 * 60 * 1000L;
        var bootId = getBootId();

        if (state.locked() && now - state.mtimeMs() < STALE_MS) {
            System.out.println("BUSY");
            throw new IllegalStateException("Lock busy");
        }

        var lockFile = memDir.resolve(".consolidate-lock");
        Files.createDirectories(memDir);
        Files.writeString(lockFile, "%d:%s:%d".formatted(ownerPid, bootId, ownerStartTimeMs(ownerPid)));

        try { Thread.sleep(50); } catch (InterruptedException e) {}

        var verifyParts = Files.readString(lockFile).trim().split(":");
        if (Long.parseLong(verifyParts[0]) != ownerPid) {
            System.out.println("BUSY");
            throw new IllegalStateException("Lost lock race");
        }

        System.out.println("ACQUIRED");
    }

    public static void release(Path memDir) throws IOException {
        var lockFile = memDir.resolve(".consolidate-lock");
        if (Files.exists(lockFile)) Files.delete(lockFile);
        System.out.println("RELEASED");
    }

    public static void status(Path memDir) throws IOException {
        var state = readLock(memDir);
        System.out.printf("mtime: %d, pid: %s, locked: %s\n",
            state.mtimeMs(),
            state.holderPid().isPresent() ? String.valueOf(state.holderPid().getAsLong()) : "none",
            state.locked());
    }

    static LockState readLock(Path memDir) throws IOException {
        var lockFile = memDir.resolve(".consolidate-lock");
        var bootId = getBootId();
        try {
            var attrs = Files.readAttributes(lockFile, BasicFileAttributes.class);
            var parts = Files.readString(lockFile).trim().split(":");
            var pid = Long.parseLong(parts[0]);
            var lockBootId = parts.length > 1 ? parts[1] : "";
            // The recorded start time is verified against the live process so a
            // recycled PID (old owner dead, PID reassigned to an unrelated
            // process) is not mistaken for the original holder. If it mismatches
            // we treat the lock as free — the recorded owner is definitively gone.
            var recordedStart = parts.length > 2 ? Long.parseLong(parts[2]) : -1;
            // When a start time was recorded, a live process must also match it
            // (a recycled PID with a different start is a different process, so
            // the lock is free). When no start was recorded (legacy pid:bootId
            // format), presence + aliveness is the best we can verify.
            var live = lockBootId.equals(bootId)
                && ProcessHandle.of(pid)
                    .filter(ph -> ph.isAlive())
                    .map(ph -> ph.info().startInstant()
                        .map(i -> recordedStart == -1 || i.toEpochMilli() == recordedStart)
                        .orElse(recordedStart == -1))
                    .orElse(false);
            return new LockState(attrs.lastModifiedTime().toMillis(), OptionalLong.of(pid), lockBootId, live);
        } catch (NoSuchFileException e) {
            return new LockState(0, OptionalLong.empty(), bootId, false);
        }
    }

    static long ownerStartTimeMs(long ownerPid) {
        return ProcessHandle.of(ownerPid)
            .flatMap(ph -> ph.info().startInstant())
            .map(i -> i.toEpochMilli())
            .orElse(0L);
    }

    static String getBootId() {
        try { return Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).trim(); }
        catch (IOException e) { return "unknown"; }
    }
}
