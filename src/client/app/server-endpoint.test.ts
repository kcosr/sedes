import { describe, expect, it } from "vitest";
import {
  configuredSedesServer,
  normalizeSedesServerUrl,
  resolveSedesServerUrl,
  resolveSedesServerWebSocketUrl,
  sameOriginSedesServer,
} from "./server-endpoint.js";

describe("Sedes server endpoints", () => {
  it("normalizes explicit HTTP and HTTPS origins", () => {
    expect(normalizeSedesServerUrl(" http://192.168.1.20:4783/ ")).toBe(
      "http://192.168.1.20:4783",
    );
    expect(normalizeSedesServerUrl("https://sedes.local:443")).toBe(
      "https://sedes.local",
    );
    expect(normalizeSedesServerUrl("http://[fd00::12]:4783")).toBe(
      "http://[fd00::12]:4783",
    );
  });

  it("requires an explicit scheme and an origin-only URL", () => {
    for (const value of [
      "192.168.1.20:4783",
      "ftp://sedes.local",
      "http://user@sedes.local",
      "http://sedes.local/api",
      "http://sedes.local?mode=test",
      "http://sedes.local#threads",
    ]) {
      expect(() => normalizeSedesServerUrl(value), value).toThrow();
    }
  });

  it("resolves only owned API paths", () => {
    expect(
      resolveSedesServerUrl(
        configuredSedesServer("http://sedes.local:4783"),
        "/api/application/session",
      ),
    ).toBe("http://sedes.local:4783/api/application/session");
    expect(
      resolveSedesServerUrl(
        sameOriginSedesServer,
        "/api/application/session",
      ),
    ).toBe("/api/application/session");
    expect(() =>
      resolveSedesServerUrl(
        configuredSedesServer("http://sedes.local:4783"),
        "/unowned",
      ),
    ).toThrow("must begin with /api/");
  });

  it("derives a secure WebSocket URL from an HTTPS server origin", () => {
    expect(
      resolveSedesServerWebSocketUrl(
        configuredSedesServer("https://sedes.local"),
        "/api/provider-feature-terminal",
      ),
    ).toBe("wss://sedes.local/api/provider-feature-terminal");
  });
});
