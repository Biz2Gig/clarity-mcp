import { describe, expect, it } from "vitest";

import { assertSafeUrl, sanitizeFilename } from "../app/video/ssrf";

const publicResolve = async () => ["93.184.216.34"];

describe("assertSafeUrl", () => {
  it("allows https to a public address", async () => {
    const { url, addresses } = await assertSafeUrl("https://example.com/v.mp4", {
      resolve: publicResolve,
    });
    expect(url.hostname).toBe("example.com");
    expect(addresses).toEqual(["93.184.216.34"]);
  });

  it("rejects plain http by default", async () => {
    await expect(
      assertSafeUrl("http://example.com/v.mp4", { resolve: publicResolve }),
    ).rejects.toThrow(/https/i);
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertSafeUrl("https://user:pass@example.com/v.mp4", { resolve: publicResolve }),
    ).rejects.toThrow(/credential/i);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private A"],
    ["172.16.5.5", "private B"],
    ["192.168.1.10", "private C"],
    ["169.254.169.254", "cloud metadata"],
    ["100.100.100.200", "CGNAT metadata"],
    ["::1", "ipv6 loopback"],
    ["fd00::1", "ipv6 ULA"],
  ])("blocks a host that resolves to %s (%s)", async (ip) => {
    await expect(
      assertSafeUrl("https://evil.example/v.mp4", { resolve: async () => [ip] }),
    ).rejects.toThrow(/blocked address|blocked ip/i);
  });

  it("blocks when ANY resolved address is private (DNS rebinding)", async () => {
    await expect(
      assertSafeUrl("https://evil.example/v.mp4", {
        resolve: async () => ["93.184.216.34", "10.0.0.5"],
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it("blocks a literal private IP in the URL", async () => {
    await expect(assertSafeUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow();
  });

  it("permits localhost http only when allowInsecure", async () => {
    await expect(assertSafeUrl("http://localhost:9000/x.csv")).rejects.toThrow();
    const { url } = await assertSafeUrl("http://localhost:9000/x.csv", {
      allowInsecure: true,
    });
    expect(url.port).toBe("9000");
  });
});

describe("sanitizeFilename", () => {
  it("strips paths and unsafe characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("my video (final).mp4")).toBe("my_video__final_.mp4");
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("/", "fallback.bin")).toBe("fallback.bin");
  });
});
