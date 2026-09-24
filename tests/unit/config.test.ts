import { describe, expect, it } from "vitest";
import {
  CAPACITOR_ANDROID_ORIGIN,
  CAPACITOR_ELECTRON_ORIGIN,
  loadConfig,
} from "../../src/server/config/config.js";

describe("loadConfig", () => {
  it("uses the production defaults when optional values are omitted", () => {
    expect(loadConfig({ APP_STATE_DIR: "/tmp/sedes-state" })).toMatchObject({
      port: 4784,
      authenticationRequired: true,
      experimentalUsageEnabled: false,
      conversationRetentionMilliseconds: 3_600_000,
      conversationRuntimeBudget: 32,
      providerPulseUrl: "http://127.0.0.1:4317",
    });
  });

  it.each([["0", false], ["1", true]] as const)(
    "accepts experimental usage opt-in %s", (value, enabled) => {
      expect(loadConfig({ SEDES_EXPERIMENTAL_USAGE: value }).experimentalUsageEnabled).toBe(enabled);
    },
  );

  it.each(["", " ", "true", "false", "01", "yes", " 1", "1 "])(
    "fails startup for malformed experimental usage opt-in %j", (value) => {
      expect(() => loadConfig({ SEDES_EXPERIMENTAL_USAGE: value })).toThrow(
        "SEDES_EXPERIMENTAL_USAGE must be exactly 0 or 1.",
      );
    },
  );

  it.each([["true", true], ["false", false]] as const)(
    "accepts explicit authentication requirement %s", (value, required) => {
      expect(loadConfig({ SEDES_AUTH_REQUIRED: value }).authenticationRequired).toBe(required);
    },
  );

  it.each(["", " ", "FALSE", "TRUE", "0", "1", "off", " false", "false "])(
    "fails startup for malformed authentication requirement %j", (value) => {
      expect(() => loadConfig({ SEDES_AUTH_REQUIRED: value })).toThrow(
        "SEDES_AUTH_REQUIRED must be exactly true or false.",
      );
    },
  );

  it.each(["off", "0", ""])(
    "disables Provider Pulse when SEDES_PROVIDER_PULSE_URL is %s",
    (configured) => {
      expect(
        loadConfig({
          APP_STATE_DIR: "/tmp/sedes-state",
          SEDES_PROVIDER_PULSE_URL: configured,
        }).providerPulseUrl,
      ).toBeNull();
    },
  );

  it("rejects a non-loopback Provider Pulse URL", () => {
    expect(() =>
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_PROVIDER_PULSE_URL: "http://192.168.1.9:4317",
      }),
    ).toThrow("SEDES_PROVIDER_PULSE_URL must bind to loopback.");
  });

  it.each([
    ["0", 0],
    ["600000", 600_000],
    ["2147483647", 2_147_483_647],
  ])("accepts conversation retention %s", (configured, expected) => {
    expect(
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_CONVERSATION_RETENTION_MILLISECONDS: configured,
      }).conversationRetentionMilliseconds,
    ).toBe(expected);
  });

  it.each([
    ["2", 2],
    ["8", 8],
    ["64", 64],
  ])("accepts conversation runtime budget %s", (configured, expected) => {
    expect(
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_CONVERSATION_RUNTIME_BUDGET: configured,
      }).conversationRuntimeBudget,
    ).toBe(expected);
  });

  it.each(["", " ", "1", "01", "8.0", "65", "9007199254740992"])(
    "rejects invalid conversation runtime budget: %s",
    (configured) => {
      expect(() =>
        loadConfig({
          APP_STATE_DIR: "/tmp/sedes-state",
          SEDES_CONVERSATION_RUNTIME_BUDGET: configured,
        }),
      ).toThrow(
        "SEDES_CONVERSATION_RUNTIME_BUDGET must be a canonical integer from 2 through 64.",
      );
    },
  );

  it.each([
    "",
    " ",
    "-1",
    "+1",
    "01",
    "1.5",
    "1e3",
    "0x10",
    "NaN",
    "Infinity",
    "2147483648",
    "9007199254740992",
  ])("rejects invalid conversation retention: %s", (configured) => {
    expect(() =>
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_CONVERSATION_RETENTION_MILLISECONDS: configured,
      }),
    ).toThrow(
      "SEDES_CONVERSATION_RETENTION_MILLISECONDS must be a canonical integer from 0 through 2147483647.",
    );
  });

  it("creates an end-state local configuration without accepting remote placeholders", () => {
    const config = loadConfig(
      {
        APP_STATE_DIR: "/tmp/sedes-state",
        PORT: "5123",
        ALLOWED_TAILSCALE_HOSTS: "sedes.example.ts.net,SECOND.example.ts.net.",
      },
      { schemaVersion: 11, packagedClients: ["android"] },
    );

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 5123,
      allowedTailscaleHosts: ["sedes.example.ts.net", "second.example.ts.net"],
      packagedClientOrigins: [CAPACITOR_ANDROID_ORIGIN],
      conversationRetentionMilliseconds: 3_600_000,
      conversationRuntimeBudget: 32,
    });
  });

  it("admits an ephemeral listener port for an owning process", () => {
    expect(
      loadConfig({ APP_STATE_DIR: "/tmp/sedes-state", PORT: "0" }).port,
    ).toBe(0);
  });

  it.each(["/workspace", "/tmp/invalid\\root", "relative", ""])(
    "rejects obsolete ambient workspace authority: %s", (root) => {
      expect(() => loadConfig({ APP_STATE_DIR: "/tmp/sedes-state", WORKSPACE_ROOTS: root })).toThrow("configuration:import --workspace-roots");
    },
  );

  it("derives packaged-client origins only from the parsed operator configuration", () => {
    expect(
      loadConfig({ APP_STATE_DIR: "/tmp/sedes-state" }).packagedClientOrigins,
    ).toEqual([]);
    expect(
      loadConfig({ APP_STATE_DIR: "/tmp/sedes-state" }, { schemaVersion: 11, packagedClients: ["electron"] })
        .packagedClientOrigins,
    ).toEqual([CAPACITOR_ELECTRON_ORIGIN]);
    expect(
      loadConfig({ APP_STATE_DIR: "/tmp/sedes-state" }, { schemaVersion: 11, packagedClients: ["android", "electron"] })
        .packagedClientOrigins,
    ).toEqual([CAPACITOR_ANDROID_ORIGIN, CAPACITOR_ELECTRON_ORIGIN]);
  });

  it("gives removed packaged-client environment variables no authority", () => {
    expect(
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_CAPACITOR_ANDROID: "1",
        SEDES_CAPACITOR_ELECTRON: "1",
      }).packagedClientOrigins,
    ).toEqual([]);
    expect(() =>
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_BIND_HOST: "0.0.0.0",
        SEDES_TRUSTED_LAN_HOST: "192.168.50.51",
        SEDES_CAPACITOR_ANDROID: "1",
        SEDES_CAPACITOR_ELECTRON: "1",
      }),
    ).toThrow("requires at least one configured packaged client");
  });

  it.each([
    "192.168.50.51",
    "10.20.30.40",
    "172.31.4.5",
    "192.168.50.0",
    "192.168.50.255",
  ])(
    "pairs the wildcard listener with one exact trusted LAN Host: %s",
    (trustedLanHost) => {
      expect(
        loadConfig(
          {
            APP_STATE_DIR: "/tmp/sedes-state",
            SEDES_BIND_HOST: "0.0.0.0",
            SEDES_TRUSTED_LAN_HOST: trustedLanHost,
          },
          { schemaVersion: 11, packagedClients: ["android"] },
        ),
      ).toMatchObject({
        host: "0.0.0.0",
        trustedLanHost,
        packagedClientOrigins: [CAPACITOR_ANDROID_ORIGIN],
      });
    },
  );

  it("requires wildcard bind, a packaged-client mode, and trusted LAN Host together", () => {
    expect(() =>
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_TRUSTED_LAN_HOST: "192.168.50.51",
      }),
    ).toThrow("requires SEDES_BIND_HOST=0.0.0.0");
    expect(() =>
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        SEDES_BIND_HOST: "0.0.0.0",
        SEDES_TRUSTED_LAN_HOST: "192.168.50.51",
      }),
    ).toThrow("requires at least one configured packaged client");
    expect(() =>
      loadConfig(
        {
          APP_STATE_DIR: "/tmp/sedes-state",
          SEDES_BIND_HOST: "0.0.0.0",
        },
        { schemaVersion: 11, packagedClients: ["android"] },
      ),
    ).toThrow("requires SEDES_TRUSTED_LAN_HOST");
  });

  it.each([
    "",
    " 192.168.50.51",
    "192.168.50.51 ",
    "localhost",
    "::1",
    "0.0.0.0",
    "127.0.0.1",
    "8.8.8.8",
    "100.64.0.1",
    "169.254.1.1",
    "172.15.1.1",
    "172.32.1.1",
    "192.167.1.1",
    "224.0.0.1",
    "10.0.0.0",
    "10.255.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "192.168.0.0",
    "192.168.255.255",
  ])("rejects an unsafe trusted LAN Host: %s", (host) => {
    expect(() =>
      loadConfig(
        {
          APP_STATE_DIR: "/tmp/sedes-state",
          SEDES_BIND_HOST: "0.0.0.0",
          SEDES_TRUSTED_LAN_HOST: host,
        },
        { schemaVersion: 11, packagedClients: ["android"] },
      ),
    ).toThrow(/private IPv4|RFC1918 unicast/);
  });

  it.each(["", "localhost", "192.168.50.51", "::", " 0.0.0.0"])(
    "rejects an unsupported bind Host: %s",
    (host) => {
      expect(() =>
        loadConfig(
          {
            APP_STATE_DIR: "/tmp/sedes-state",
            SEDES_BIND_HOST: host,
            SEDES_TRUSTED_LAN_HOST: "192.168.50.51",
          },
          { schemaVersion: 11, packagedClients: ["android"] },
        ),
      ).toThrow("must be exactly 127.0.0.1 or 0.0.0.0");
    },
  );

  it.each(["00", "01", "1023", "65536", "4783junk", ""])(
    "rejects invalid ports: %s",
    (port) => {
      expect(() =>
        loadConfig({ APP_STATE_DIR: "/tmp/sedes-state", PORT: port }),
      ).toThrow();
    },
  );

  it("rejects relative state paths", () => {
    expect(() => loadConfig({ APP_STATE_DIR: "relative" })).toThrow(
      "APP_STATE_DIR must be an absolute path",
    );
    expect(() =>
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        WORKSPACE_ROOTS: "relative",
      }),
    ).toThrow("WORKSPACE_ROOTS is no longer startup configuration");
  });

  it.each([
    "https://host.example.ts.net",
    "*.example.ts.net",
    "host.example.ts.net:443",
    "127.0.0.1",
    "bad_label.example.ts.net",
    "one.example.ts.net,,two.example.ts.net",
  ])("rejects malformed Tailscale host entries: %s", (hosts) => {
    expect(() =>
      loadConfig({
        APP_STATE_DIR: "/tmp/sedes-state",
        ALLOWED_TAILSCALE_HOSTS: hosts,
      }),
    ).toThrow("invalid hostname");
  });
});
