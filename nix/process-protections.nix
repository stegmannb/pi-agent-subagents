{ pkgs, mkProtectionVM }:
let
  inputs = import ./protection-bundle.nix { inherit pkgs; };
  run =
    name: files:
    mkProtectionVM {
      name = "process-protections-${name}";
      captureDiagnostics = builtins.elem name [
        "nested-review"
        "taskflow-qualification"
      ];
      preparedBundle = inputs.preparedBundle;
      command = [
        "env"
        "PASA_PROTECTION_PREPARED=1"
        "PASA_PROTECTION_VM=1"
        "bash"
        "-euo"
        "pipefail"
        "-c"
        (
          "node tests/process/protection-sources.ts && node --test --test-concurrency=1 "
          + pkgs.lib.escapeShellArgs files
        )
      ];
      runtimePackages = [
        pkgs.pnpm_10
        pkgs.which
        pkgs.bash
      ];
      # Leave 300 s beyond the 2100-s case budget for guest boot and log/VM cleanup.
      timeoutSeconds = 2400;
    };
  suites = {
    taskflow-qualification = run "taskflow-qualification" [
      "tests/process/qualification-real.test.ts"
      "tests/process/qualification-lifecycle-real.test.ts"
      "tests/process/delegation-results-real.test.ts"
      "tests/process/result-persistence-real.test.ts"
    ];
    lifecycle = run "lifecycle" [
      "src/process-lifecycle.test.ts"
      "tests/process/lifecycle-rpc-real.test.ts"
      "tests/process/lifecycle-host-real.test.ts"
    ];
    baseline-rpc = run "baseline-rpc" [
      "tests/process/protections-real.test.ts"
    ];
    baseline-ui = run "baseline-ui" [
      "tests/process/protections-role-real.test.ts"
      "tests/process/protections-tui-real.test.ts"
    ];
    nested-review = run "nested-review" [
      "tests/process/protections-delegation-real.test.ts"
    ];
    nested-roles = run "nested-roles" [
      "tests/process/protections-delegation-roles-real.test.ts"
    ];
    communication-joins = run "communication-joins" [
      "tests/process/delegation-real.test.ts"
    ];
    communication-address = run "communication-address" [
      "tests/process/delegation-address-real.test.ts"
    ];
    communication-help = run "communication-help" [
      "tests/process/delegation-help-real.test.ts"
    ];
    communication-results = run "communication-results" [
      "tests/process/delegation-results-real.test.ts"
      "tests/process/group-processes-real.test.ts"
      "tests/process/result-persistence-real.test.ts"
    ];
  };
in
{
  inherit suites;
  aggregate = pkgs.runCommand "process-protections-all" { } (
    ''mkdir -p "$out"''
    + "\n"
    + pkgs.lib.concatStringsSep "\n" (
      pkgs.lib.mapAttrsToList (name: output: ''cp -R ${output} "$out/${name}"'') suites
    )
  );
}
