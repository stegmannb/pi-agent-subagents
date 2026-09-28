{ pkgs, lib }:
{
  name,
  preparedBundle,
  command,
  runtimePackages ? [ ],
  timeoutSeconds ? 1200,
  memorySize ? 4096,
  diskSize ? 8192,
  cores ? 2,
}:
assert lib.assertMsg pkgs.stdenv.hostPlatform.isLinux "protection-vm requires Linux pkgs";
assert lib.assertMsg (
  lib.isDerivation preparedBundle || builtins.isPath preparedBundle
) "preparedBundle must be a derivation or a Nix path, not a mutable path string";
assert lib.assertMsg (
  builtins.isList command && command != [ ] && lib.all builtins.isString command
) "command must be a nonempty argv list";
assert lib.assertMsg (
  builtins.isInt timeoutSeconds && timeoutSeconds > 0 && timeoutSeconds <= 3600
) "timeoutSeconds must be between 1 and 3600";
let
  bundle =
    if builtins.isPath preparedBundle then builtins.path { path = preparedBundle; } else preparedBundle;
  packages = [
    pkgs.nodejs_22
    pkgs.bash
    pkgs.git
    pkgs.coreutils
    pkgs.gnutar
    pkgs.gzip
    pkgs.bubblewrap
    pkgs.socat
    pkgs.ripgrep
  ]
  ++ runtimePackages;
  runBundle = pkgs.writeShellScript "run-protection-bundle" ''
    set -euo pipefail
    test "$(id -u)" = 1000
    test -d ${lib.escapeShellArg (toString bundle)}
    mkdir -p /home/test/work
    cp -a --no-preserve=ownership ${lib.escapeShellArg "${bundle}/."} /home/test/work/
    chmod -R u+w /home/test/work
    cd /home/test/work
    exec ${lib.escapeShellArgs command}
  '';
in
pkgs.testers.runNixOSTest {
  inherit name;
  globalTimeout = timeoutSeconds;
  # TCG needs neither host KVM nor host user namespaces, even on a builder
  # without the conventional nixos-test scheduling feature.
  requiredFeatures = {
    kvm = false;
    nixos-test = false;
  };
  qemu.forceAccel = false;

  nodes.machine = {
    virtualisation = {
      inherit memorySize diskSize cores;
      restrictNetwork = true;
      forwardPorts = [ ];
      vlans = [ ];
      # A closure-only disk avoids exposing unrelated host store paths.
      useNixStoreImage = true;
      mountHostNixStore = false;
      writableStore = false;
      useHostCerts = false;
      sharedDirectories = lib.mkForce { };
      qemu.networkingOptions = lib.mkForce [ "-nic none" ];
      qemu.options = [ "-machine accel=tcg" ];
    };
    security.unprivilegedUsernsClone = true;
    security.sudo.enable = false;
    services.openssh.enable = false;
    users.users.test = {
      isNormalUser = true;
      uid = 1000;
      home = "/home/test";
      createHome = true;
    };
    environment.systemPackages = packages;
    systemd.services.protection-test = {
      description = "Run the immutable offline protection test bundle";
      # The driver starts this explicitly after proving the guest booted.
      serviceConfig = {
        Type = "oneshot";
        User = "test";
        Group = "users";
        WorkingDirectory = "/home/test";
        TimeoutStartSec = timeoutSeconds;
        KillMode = "control-group";
        RemainAfterExit = true;
        StandardOutput = "journal+console";
        StandardError = "journal+console";
        ExecStart = lib.escapeShellArgs [
          "${pkgs.coreutils}/bin/env"
          "-i"
          "HOME=/home/test"
          "USER=test"
          "LOGNAME=test"
          "LANG=C.UTF-8"
          "PATH=${lib.makeBinPath packages}"
          "${runBundle}"
        ];
      };
    };
    system.stateVersion = "25.11";
  };

  testScript = ''
    import os
    from pathlib import Path

    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.succeed("test $(id -u test) -eq 1000")
    try:
        machine.succeed("systemctl start protection-test.service", timeout=${toString timeoutSeconds})
        machine.succeed("test $(systemctl show -p ExecMainStatus --value protection-test.service) -eq 0")
    finally:
        _, output = machine.execute("journalctl -u protection-test.service --no-pager -o cat", timeout=30)
        print(output)
        Path(os.environ["out"], "protection-test.log").write_text(output)
        _, journal = machine.execute("journalctl -u protection-test.service --no-pager", timeout=30)
        print(journal)
        Path(os.environ["out"], "protection-test-journal.log").write_text(journal)
    # Guest OS shutdown is not under test. End only this disposable QEMU after
    # successful assertions and persisted logs; crash() waits for its exit.
    machine.crash()
  '';
}
