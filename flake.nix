{
  description = "pi-agent-subagents packaged as a Nix flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      lib.mkProtectionVM = import ./nix/protection-vm.nix {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        inherit (nixpkgs) lib;
      };

      checks.x86_64-linux.protection-vm-smoke =
        let
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
          mkProtectionVM = import ./nix/protection-vm.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
          };
        in
        mkProtectionVM {
          name = "protection-vm-smoke";
          preparedBundle = ./tests/vm;
          command = [
            "node"
            "smoke.mjs"
          ];
        };

      checks.x86_64-linux.process-protections =
        let
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
        in
        import ./nix/process-protections.nix {
          inherit pkgs;
          mkProtectionVM = import ./nix/protection-vm.nix {
            inherit pkgs;
            inherit (nixpkgs) lib;
          };
        };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          package = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = package;
          pi-agent-subagents = package;
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
