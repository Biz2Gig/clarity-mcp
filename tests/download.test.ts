import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { downloadToTempFile } from "../app/video/download.server";

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

const publicResolve = async () => ["93.184.216.34"];

describe("downloadToTempFile - security", () => {
  it("rejects a response whose declared Content-Length exceeds the limit", async () => {
    const fetchImpl = (async () =>
      new Response(bodyOf([new Uint8Array(4)]), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "999999" },
      })) as unknown as typeof fetch;

    await expect(
      downloadToTempFile("https://ok.example/v.mp4", {
        kind: "video",
        maxBytes: 100,
        resolve: publicResolve,
        fetchImpl,
      }),
    ).rejects.toThrow(/exceeds limit/i);
  });

  it("enforces the byte cap while streaming (no Content-Length)", async () => {
    const big = [new Uint8Array(60), new Uint8Array(60)];
    const fetchImpl = (async () =>
      new Response(bodyOf(big), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })) as unknown as typeof fetch;

    await expect(
      downloadToTempFile("https://ok.example/v.mp4", {
        kind: "video",
        maxBytes: 100,
        resolve: publicResolve,
        fetchImpl,
      }),
    ).rejects.toThrow(/limit/i);
  });

  it("rejects a disallowed Content-Type", async () => {
    const fetchImpl = (async () =>
      new Response(bodyOf([new Uint8Array(4)]), {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    await expect(
      downloadToTempFile("https://ok.example/v.mp4", {
        kind: "video",
        resolve: publicResolve,
        fetchImpl,
      }),
    ).rejects.toThrow(/not an allowed/i);
  });

  it("re-validates the target after a redirect (blocks redirect-to-internal)", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = String(input instanceof URL ? input.href : input);
      if (u.includes("internal.example")) {
        return new Response(bodyOf([new Uint8Array(1)]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://internal.example/secret.mp4" },
      });
    }) as unknown as typeof fetch;

    await expect(
      downloadToTempFile("https://ok.example/v.mp4", {
        kind: "video",
        fetchImpl,
        resolve: async (host: string) =>
          host === "internal.example" ? ["10.0.0.9"] : ["93.184.216.34"],
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it("limits the redirect chain", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://ok.example/hop-${n}.mp4` },
      });
    }) as unknown as typeof fetch;

    await expect(
      downloadToTempFile("https://ok.example/v.mp4", {
        kind: "video",
        fetchImpl,
        resolve: publicResolve,
      }),
    ).rejects.toThrow(/redirect/i);
  });

  it("downloads a small allowed file and cleans up", async () => {
    const fetchImpl = (async () =>
      new Response(bodyOf([new Uint8Array([0, 1, 2, 3, 4])]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      })) as unknown as typeof fetch;

    const res = await downloadToTempFile("https://ok.example/clip.mp4", {
      kind: "video",
      resolve: publicResolve,
      fetchImpl,
    });
    expect(res.bytes).toBe(5);
    expect(res.contentType).toBe("video/mp4");
    await expect(access(res.path)).resolves.toBeUndefined();

    await res.cleanup();
    await expect(access(res.path)).rejects.toThrow();
  });
});
