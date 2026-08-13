{
  description = "Dev shell for llm-harness-plugins — graphrag plugin development/testing";

  # Pinned to the same nixpkgs rev as ivp-book-series/flake.lock so the
  # harness and the consumer project resolve the same graphrag version.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/68d8aa3d661f0e6bd5862291b5bb263b2a6595c9";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      # Test suites of transitive graphrag deps fail at this nixpkgs rev:
      # - pot: scipy removed distance metrics (sokalmichener) — 5 failures
      # - hyppo: statistical tests with hardcoded expectations — 4 failures
      # graspologic checks disabled preemptively (same risk class, and their
      # test suites need network/LLM access the sandbox lacks).
      # graphrag itself: np.float_ removed in NumPy 2.0 (prompt_tune type
      # annotation, imported at CLI startup) — patched below, checks off.
      # All packaging-level issues irrelevant to graphrag functionality.
      # Remove once the pinned nixpkgs carries fixed derivations.
      noCheck = [ "pot" "hyppo" "graspologic" ];
      pkgs = (import nixpkgs { inherit system; }).extend (final: prev: {
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
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          pkgs.python312Packages.graphrag
          pkgs.pandoc
        ];
      };
    };
}
