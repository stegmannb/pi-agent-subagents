{ pkgs, mkProtectionVM }:
let
  inputs = import ./protection-bundle.nix { inherit pkgs; };
in
mkProtectionVM {
  name = "process-protections";
  preparedBundle = inputs.preparedBundle;
  command = [
    "env"
    "PASA_PROTECTION_PREPARED=1"
    "PASA_PROTECTION_VM=1"
    "pnpm"
    "run"
    "test:process:protections"
  ];
  runtimePackages = [
    pkgs.pnpm_10
    pkgs.which
  ];
  timeoutSeconds = 1200;
}
