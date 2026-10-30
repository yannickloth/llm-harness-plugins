{
  description = "Dev shell for llm-harness-plugins — graphrag plugin development/testing";

  # Pinned to the same nixpkgs rev as ivp-book-series/flake.lock so the
  # harness and the consumer project resolve the same graphrag version.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/68d8aa3d661f0e6bd5862291b5bb263b2a6595c9";

  # graphrag's Python/Rust closure (datafusion, pylance, lancedb, ...) is not
  # prebuilt on cache.nixos.org, so it compiles from source. Pin the nixpkgs
  # that supplies graphrag to the same fixed rev as health-me-cfs/flake.nix
  # (its `nixpkgs-graphrag` input) so both repos resolve byte-identical
  # graphrag derivations and share one build. Keep this rev AND the overlay
  # below in sync with health-me-cfs. See that repo's commit 405929e4.
  inputs.nixpkgs-graphrag.url = "github:NixOS/nixpkgs/8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe";

  outputs = { self, nixpkgs, nixpkgs-graphrag }:
    let
      system = "x86_64-linux";
      # Test suites of transitive graphrag deps fail at this nixpkgs rev:
      # - pot: scipy removed distance metrics (sokalmichener) — 5 failures
      # - hyppo: statistical tests with hardcoded expectations — 4 failures
      # - graspologic: same risk class (test suites need network/LLM access)
      # - inline-snapshot: test_docs.py + test_example.py assert the exact
      #   output of a specific `black` version (fastapi -> openai -> graphrag)
      # - fnllm: check imports numpy without declaring it in check inputs
      # graphrag itself: np.float_ removed in NumPy 2.0 (prompt_tune type
      # annotation, imported at CLI startup) — patched below, checks off.
      # All packaging-level issues irrelevant to graphrag functionality.
      # Remove once the pinned nixpkgs carries fixed derivations.
      #
      # This list (and the graphrag override below) must stay equivalent to
      # the overlay in health-me-cfs/flake.nix: that is what makes the two
      # repos' graphrag derivations hash-identical.
      noCheck = [ "pot" "hyppo" "graspologic" "inline-snapshot" "fnllm" ];
      # Plain nixpkgs for everything except graphrag (pandoc, mkShell, ...).
      basePkgs = import nixpkgs { inherit system; };
      # Must use legacyPackages (like health-me-cfs): it applies nixpkgs'
      # impure-overlays + lib version-info overlay, so the derived packages
      # hash identically to that repo's.
      graphragPkgs = (nixpkgs-graphrag.legacyPackages.${system}).extend (final: prev: {
        python312 = prev.python312.override (old: {
          packageOverrides = self: super:
            let
              base = (old.packageOverrides or (s: p: { })) self super;
              unchecked = builtins.listToAttrs (map (name: {
                inherit name;
                value = super.${name}.overridePythonAttrs (_: { doCheck = false; });
              }) noCheck);
            in base // unchecked // {
              graphrag = super.graphrag.overridePythonAttrs (_: {
                doCheck = false;
                postPatch = ''
                  sed -i 's/np\.float_/np.float64/g' graphrag/prompt_tune/loader/input.py
                '';
              });
            };
        });
      });
    in {
      devShells.${system}.default = basePkgs.mkShell {
        buildInputs = [
          graphragPkgs.python312Packages.graphrag
          basePkgs.pandoc
        ];
      };
    };
}
