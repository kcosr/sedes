import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPiBubblewrapArguments,
  defaultPiSandboxSystemMounts,
  PI_SANDBOX_NODE_PATH,
  PI_SANDBOX_WORKER_PATH,
} from "../../src/server/pi-sandbox/bubblewrap-policy.js";

const allocation = {
  hostHomePath: "/var/lib/sedes/pi-sandboxes/allocation-123/home",
  hostWorkspacePath:
    "/var/lib/sedes/pi-sandboxes/allocation-123/home/workspace",
  workerArtifactPath: "/opt/sedes/pi-sandbox-worker.mjs",
  workerNodePath: "/opt/sedes/node",
  workspaceAccess: "writable_clone",
} as const;

function argumentsFor(networkMode: "isolated" | "execution_host") {
  return buildPiBubblewrapArguments({
    ...allocation,
    networkMode,
    systemMounts: ["/usr", "/bin", "/lib"],
  });
}

function optionValues(arguments_: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === option) values.push(arguments_[index + 1] ?? "");
  }
  return values;
}

function mountSources(arguments_: readonly string[], option: string): string[] {
  const sources: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === option) sources.push(arguments_[index + 1] ?? "");
  }
  return sources;
}

function environmentValues(
  arguments_: readonly string[],
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--setenv") {
      values.set(arguments_[index + 1] ?? "", arguments_[index + 2] ?? "");
    }
  }
  return values;
}

describe("Pi Bubblewrap security policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses mandatory namespaces, session fencing, and no best-effort isolation", () => {
    const arguments_ = argumentsFor("isolated");

    expect(arguments_).toEqual(
      expect.arrayContaining([
        "--unshare-all",
        "--unshare-user",
        "--disable-userns",
        "--assert-userns-disabled",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
      ]),
    );
    expect(arguments_.some((argument) => argument.endsWith("-try"))).toBe(
      false,
    );
    expect(arguments_).not.toContain("--share-net");
    expect(optionValues(arguments_, "--cap-drop")).toEqual(["ALL"]);
    expect(optionValues(arguments_, "--proc")).toEqual(["/proc"]);
    expect(optionValues(arguments_, "--dev")).toEqual(["/dev"]);
    expect(optionValues(arguments_, "--tmpfs")).toEqual(["/tmp", "/run"]);
  });

  it("shares networking only for the explicit execution-host profile", () => {
    expect(argumentsFor("isolated")).not.toContain("--share-net");
    expect(argumentsFor("execution_host")).toContain("--share-net");
  });

  it("pins the production execution-host runtime, DNS, and CA allowlist", () => {
    const expectedSystemMounts = [
      "/usr",
      "/bin",
      "/lib",
      "/lib64",
      "/etc/alternatives",
      "/etc/ca-certificates",
      "/etc/ssl",
      "/etc/hosts",
      "/etc/nsswitch.conf",
      "/etc/resolv.conf",
    ];
    expect(defaultPiSandboxSystemMounts()).toEqual(expectedSystemMounts);

    const arguments_ = buildPiBubblewrapArguments({
      ...allocation,
      networkMode: "execution_host",
    });
    expect(arguments_).toContain("--share-net");
    expect(mountSources(arguments_, "--ro-bind")).toEqual([
      ...expectedSystemMounts,
      allocation.workerArtifactPath,
      allocation.workerNodePath,
    ]);
    expect(mountSources(arguments_, "--ro-bind")).toEqual(
      expect.arrayContaining([
        "/etc/ca-certificates",
        "/etc/ssl",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/resolv.conf",
      ]),
    );
    for (const forbidden of ["/", "/etc", "/home", "/root", "/run"]) {
      expect(
        mountSources(arguments_, "--ro-bind"),
        `forbidden broad read-only mount: ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  it("binds the writable home and nested writable workspace explicitly", () => {
    const arguments_ = argumentsFor("isolated");

    expect(mountSources(arguments_, "--bind")).toEqual([
      allocation.hostHomePath,
      allocation.hostWorkspacePath,
    ]);
    expect(mountSources(arguments_, "--ro-bind")).toEqual([
      "/usr",
      "/bin",
      "/lib",
      allocation.workerArtifactPath,
      allocation.workerNodePath,
    ]);
    expect(arguments_).toContain(PI_SANDBOX_WORKER_PATH);
    expect(arguments_).toContain(PI_SANDBOX_NODE_PATH);

    const exposedSources = [
      ...mountSources(arguments_, "--bind"),
      ...mountSources(arguments_, "--ro-bind"),
    ];
    expect(exposedSources).not.toContain("/");
    expect(exposedSources).not.toContain("/home");
    expect(exposedSources).not.toContain("/run");
    expect(exposedSources).not.toContain(homedir());
  });

  it("overlays a read-only source inside the durable writable home", () => {
    const source = "/srv/projects/plain-source";
    const arguments_ = buildPiBubblewrapArguments({
      ...allocation,
      hostWorkspacePath: source,
      workspaceAccess: "read_only",
      networkMode: "isolated",
      systemMounts: ["/usr", "/bin", "/lib"],
    });

    expect(mountSources(arguments_, "--bind")).toEqual([
      allocation.hostHomePath,
    ]);
    expect(mountSources(arguments_, "--ro-bind")).toEqual([
      source,
      "/usr",
      "/bin",
      "/lib",
      allocation.workerArtifactPath,
      allocation.workerNodePath,
    ]);
    const sourceIndex = arguments_.indexOf(source);
    expect(arguments_.slice(sourceIndex - 1, sourceIndex + 2)).toEqual([
      "--ro-bind",
      source,
      "/home/agent/workspace",
    ]);
  });

  it("reconstructs a private environment without ambient credential selectors", () => {
    const arguments_ = argumentsFor("isolated");
    const environment = environmentValues(arguments_);
    const names = [...environment.keys()];

    expect(names).toEqual([
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "PATH",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]);
    for (const forbidden of [
      "SSH_AUTH_SOCK",
      "GIT_CONFIG_GLOBAL",
      "GIT_ASKPASS",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "DBUS_SESSION_BUS_ADDRESS",
      "DOCKER_HOST",
    ]) {
      expect(environment.has(forbidden), forbidden).toBe(false);
    }
    expect(environment.get("HOME")).toBe("/home/agent");
    expect(environment.get("PATH")).toBe(
      "/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(optionValues(arguments_, "--chdir")).toEqual(["/home/agent"]);
  });

  it("preserves Electron's explicit Node runtime mode for the nested worker", () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    expect(
      environmentValues(argumentsFor("isolated")).get("ELECTRON_RUN_AS_NODE"),
    ).toBe("1");

    vi.stubEnv("ELECTRON_RUN_AS_NODE", "true");
    expect(
      environmentValues(argumentsFor("isolated")).has("ELECTRON_RUN_AS_NODE"),
    ).toBe(false);
  });

  it("rejects non-canonical and authority-overlapping host inputs", () => {
    expect(() =>
      buildPiBubblewrapArguments({
        ...allocation,
        hostHomePath: "relative/home",
        networkMode: "isolated",
      }),
    ).toThrowError("pi_sandbox_home_invalid");
    expect(() =>
      buildPiBubblewrapArguments({
        ...allocation,
        hostWorkspacePath: "/var/lib/sedes/other-workspace",
        networkMode: "isolated",
      }),
    ).toThrowError("pi_sandbox_workspace_outside_home");
    expect(() =>
      buildPiBubblewrapArguments({
        ...allocation,
        workspaceAccess: "read_only",
        networkMode: "isolated",
      }),
    ).toThrowError("pi_sandbox_read_only_workspace_overlaps_home");
    expect(() =>
      buildPiBubblewrapArguments({
        ...allocation,
        networkMode: "isolated",
        systemMounts: [allocation.hostHomePath],
      }),
    ).toThrowError("pi_sandbox_system_mount_overlaps_home");
    expect(() =>
      buildPiBubblewrapArguments({
        ...allocation,
        networkMode: "isolated",
        systemMounts: ["/usr/../etc"],
      }),
    ).toThrowError("pi_sandbox_system_mount_invalid");
  });
});
