{ pkgs, lib, ... }:
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    corepack.enable = true;
    pnpm.enable = true;
  };

  packages =
    with pkgs;
    [
      git
      ripgrep
      socat
    ]
    ++ lib.optional stdenv.isLinux bubblewrap;

  enterShell = ''
    echo "pi-agent-subagents devenv ready"
    echo "Use: pnpm install && pnpm run check"
  '';

  tasks = {
    "test:mirror" = {
      description = "Test two-way synchronization with real Git repositories.";
      exec = "node --test tests/sync-mirror.test.mjs";
      showOutput = true;
    };

    "deps:install" = {
      description = "Install the locked pnpm dependencies.";
      exec = "pnpm install --frozen-lockfile";
    };

    "check:fmt" = {
      description = "Check source and test formatting.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run ci:fmt";
    };

    "check:lint" = {
      description = "Lint source and tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run ci:lint";
    };

    "check:types" = {
      description = "Type-check source and tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run ci:check";
    };

    "test:unit" = {
      description = "Run the unit and worktree tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm test";
      showOutput = true;
    };

    "test:snapshots" = {
      description = "Run real Git snapshot and integration tests.";
      after = [ "deps:install" ];
      exec = "pnpm run test:snapshots";
      showOutput = true;
    };

    "test:tui" = {
      description = "Run the real pi TUI test suite.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run test:tui";
      showOutput = true;
    };

    "test:process" = {
      description = "Run RPC transport and deterministic companion-host tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run test:process";
      showOutput = true;
    };

    "test:delegation" = {
      description = "Run actual SDK delegation, messaging, result persistence and workspace tool tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run test:delegation";
      showOutput = true;
    };

    "test:lifecycle" = {
      description = "Run ownership, bounded termination, dialog and result-gated cleanup tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run test:lifecycle";
      showOutput = true;
    };

    "test:qualification" = {
      description = "Qualify nested review, event-driven joins, persistent results and owned cleanup with real Pi processes.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec =
        if pkgs.stdenv.isLinux then
          "nix build --no-update-lock-file --print-build-logs .#checks.x86_64-linux.process-protections-taskflow-qualification"
        else
          "pnpm run test:qualification";
      showOutput = true;
    };

    "test:process:tui" = {
      description = "Run the interactive companion-host RPC test.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run test:process:tui";
      showOutput = true;
    };

    "test:process:protections" = {
      description = "Verify real Guard and OS Sandbox, using the isolated VM on Linux.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec =
        if pkgs.stdenv.isLinux then
          "nix build --no-update-lock-file --print-build-logs .#checks.x86_64-linux.process-protections"
        else
          "pnpm run test:process:protections";
      showOutput = true;
    };

    "test:tui:repeat" = {
      description = "Run three full TUI suites to check timing stability.";
      after = [ "deps:install" ];
      exec = "pnpm run test:tui:repeat";
      showOutput = true;
    };
  };
}
