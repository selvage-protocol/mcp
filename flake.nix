{
  description = "Selvage's MCP server: the Model Context Protocol front end that drives the session protocol's sync engine";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  inputs.git-hooks = {
    url = "github:cachix/git-hooks.nix";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    git-hooks,
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
    ];

    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

    # Everything below is built from this one record, so that the Node the suites run on is the
    # Node `nix develop` hands out and the dependency tree they resolve against is built from
    # the committed lock file rather than from a checkout's directory.
    mkSelvage = pkgs: let
      node = pkgs.nodejs_22;

      # The server is Node, and its imports — the vendored engine's `yjs`, `y-protocols`,
      # `lib0` and `ws` along with the sources' own — resolve from a `node_modules` beside
      # it. That directory is built from the lock file rather than taken from a checkout's,
      # because it is ignored by git and so never reaches the store copy a flake sees.
      nodeModules = pkgs.importNpmLock.buildNodeModules {
        npmRoot = self;
        nodejs = node;
      };

      # The hooks `nix develop` installs into whatever checkout the shell is started in. The
      # set is this repository's: file hygiene, the Nix the flake is written in, and the two
      # checkers the gate already runs — actionlint over the workflows and lychee over the
      # reader-facing prose. `checks.pre-commit` builds the same set, so a hook that could
      # not run is a red check rather than a surprise at commit time.
      hooks = git-hooks.lib.${pkgs.stdenv.hostPlatform.system}.run {
        src = ./.;

        hooks = {
          alejandra.enable = true;
          deadnix.enable = true;
          check-json.enable = true;
          check-toml.enable = true;
          check-yaml.enable = true;
          check-merge-conflicts.enable = true;
          check-added-large-files.enable = true;
          check-executables-have-shebangs.enable = true;
          check-shebang-scripts-are-executable.enable = true;
          forbid-new-submodules.enable = true;
          actionlint.enable = true;

          # The bare hook reads every text file the tree holds, which includes `vendor/` and the
          # workflow's templated lychee URL — neither of which is in this repository's link-check
          # scope. It is scoped and configured the way `scripts/ci-local.sh links` and the
          # `checks` job run it, so the hook and the gate report the same thing.
          lychee = {
            enable = true;
            files = "^(README\\.md|docs/)";
            args = [
              "--config"
              "lychee.toml"
              "--no-progress"
            ];
          };
        };
      };
    in {
      inherit node nodeModules hooks;
    };

    forAllSelvage = f: forAllSystems (pkgs: f pkgs (mkSelvage pkgs));
  in {
    # Node and the hook set above. The Node is a named version rather than whatever the host
    # happens to have: it is the one `package.json`'s `engines` promises and the one the
    # checks below run on.
    devShells = forAllSelvage (pkgs: selvage: {
      default = pkgs.mkShell {
        packages =
          [
            selvage.node
          ]
          ++ selvage.hooks.enabledPackages;

        inherit (selvage.hooks) shellHook;
      };
    });

    checks = forAllSelvage (
      pkgs: selvage: let
        # The suites run in a writable copy of the source with the store's dependency tree
        # linked in: flake sources are read-only, and the suites write scratch under `.tmp/`.
        #
        # The suite's own output goes to stderr, and `$out` gets one stable line: the log
        # carries per-test timings, and a derivation whose output differs from build to build
        # is one `nix build --rebuild` rightly calls non-deterministic.
        mkSuite = name: inputs: steps:
          pkgs.runCommand name
          {
            nativeBuildInputs = inputs;
          }
          ''
            cp -r ${self} work
            chmod -R u+w work
            ln -s ${selvage.nodeModules}/node_modules work/node_modules
            cd work
            export HOME=$TMPDIR
            log=$TMPDIR/suite.log
            if (${pkgs.lib.concatStringsSep " && " steps}) > $log 2>&1; then
              cat $log >&2
              echo "${name}: passed" > $out
            else
              cat $log >&2
              echo "${name}: FAILED" > $out
              exit 1
            fi
          '';
      in {
        typecheck = mkSuite "mcp-typecheck" [selvage.node] ["npm run typecheck"];

        # `npm test` and not `npm run test:e2e` beside it: the two-process proof needs a built
        # `selvaged` from the sibling `reference_server` repository, and a sandbox has no sibling
        # checkout. `scripts/ci-local.sh e2e`, from a checkout that has one, runs it.
        suite = mkSuite "mcp-suite" [selvage.node] ["npm test"];

        pre-commit = selvage.hooks;
      }
    );
  };
}
