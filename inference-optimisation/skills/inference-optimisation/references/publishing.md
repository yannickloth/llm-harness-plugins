# Qualifying and publishing a tuned recipe

A tuned config is only useful if someone else can rebuild it and get the same result.

## 1. Land the code

- Commit kernel and engine-plugin changes to a branch of a public repo. A published build must fetch a pinned commit, never a local patch or a dirty tree.
- Put data files the config needs (draft vocabularies, configs) in the recipe source. Copy them into the image.

## 2. Pin and build cleanly

- **Pin everything:**
  - the base image by digest;
  - the engine and kernel source by commit;
  - Python packages by version (fail the build if `pip freeze` differs);
  - weights by repository revision.
- **Build from a clean checkout of the exact recipe commit.** Keep the build log as evidence.
- **Build every library with the same flags you benchmarked.** Never load two builds of the same op library in one process.

## 3. Write the launch exactly as benchmarked

- Copy the environment and arguments from the best config, then diff them mechanically. Change nothing "while you're there".
- **The launch contains only levers the harness accepted.** A lever disposed `not-actionable` is not in it, and neither is a lever the user asked for against the evidence — if one is installed, the recipe names it next to the flag (`installed by instruction, not by evidence`, with the power number) and the advertised numbers exclude it. A published recipe is a list of accepted levers, not a list of things that were tried.
- Make advertised numbers true. If a registry derives KV capacity as `ctx × seqs (+ margin)`, set the engine's pool to that value. Note any difference from what you soak-tested.

## 4. Acceptance gates (all required, on the clean build)

These are the **publish** gates, run on the clean build. They are not the per-lever
stability gates from SKILL.md §2 rule 6 (needle retrieval, soak, greedy equivalence),
which run during the hill-climb on each accepted lever. The publish gates are stricter
and run on the build you are shipping, not on the config you tuned; passing the
per-lever gates does not substitute for them, and a config that passed every lever gate
still has to pass all of these from a clean checkout.

1. **Load:** the server becomes healthy, and `/v1/models` lists the model.
2. **Chat:** a short answer with a stop finish.
3. **Reasoning:** thinking separated from content, with the correct answer.
4. **Tools:** a full round trip. The model calls the tool, receives the tool result, and quotes a code from it.
5. **Context:** a needle in a document at about 85% of the window, answered exactly.
6. **Speed:** single-user decode over the first 30 s after the first token, with no output cap, counted with the server tokenizer, above a floor.
- Also check **vision** if the model has it, plus a **concurrent full-length soak** if the recipe advertises N users at full context. Use the sustained form (`bench.py --sustained-cN`), not the burst form: a burst cN number does not describe a full-context soak, and advertising it as one overstates the recipe.
- Gate the same config more than once if acceptance ramps up (draft methods with warm-up). Never publish a "validated" result from a single wave.
- Record peak memory: driver residency plus anon on unified memory.

## 5. Prove the published build equals the best

- Run your harness back to back on the clean build and your hill-climb best image, against interleaved controls. They should match within noise.
- If they don't, find the difference before publishing.

## 6. Publish

- **Branch from the current main.** Squash-merged repos don't contain your old branch history.
- **Keep any branch that holds a pinned build commit alive.** Deleting it breaks reproducibility, unless the commit is also reachable from main or a PR ref.
- **Evidence to commit:**
  - the gate run JSON;
  - the rendered launch and its hash;
  - build and server logs;
  - memory samples;
  - the vision response;
  - the check and test logs;
  - the experiment log (`PLAN.md`, `THEORY.md`, ledger).
- **Grep the bundle** for secrets, credential-file paths, tokens, personal emails and home-directory usernames before pushing.
- **State in the README** which numbers come from the gates and which from the hill-climb harness, and how each was measured.
- **State the statistics with the number.** For each advertised delta, give n per side, the exact alpha the test could reach, and the measured per-dimension MAD. "+31% c1 decode" with no n and no noise floor is not a reproducible claim; "+31% (n=6+6, exact p=0.047, MAD 2.1%)" is.
- **State the ceiling and the sustained/peak basis.** A number at 95% of a peak ceiling on a laptop is a different claim than one at 95% of the sustained ceiling.

## 7. Results card or poster (optional)

- Use medians, not best runs, and show honest `was X → now Y (+Z%)` deltas.
- Label cold vs warm and single runs vs medians.
- If you have a house template, change only the values. Render headless:
  ```bash
  chromium --headless=new --force-device-scale-factor=2 --window-size=1024,574 --screenshot=out.png file://$PWD/card.html
  ```
