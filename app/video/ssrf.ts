/**
 * SSRF / URL safety policy. Used for every remotely supplied URL
 * (`videoUrl`, `csvUrl`) before and after each redirect hop.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

import { SecurityError } from "../errors";

export interface UrlPolicyOptions {
  /** Permit `http:` and private/loopback targets (development only). */
  allowInsecure?: boolean;
  /** DNS resolver override for tests. Returns resolved IP strings. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** IPv4 / IPv6 ranges that must never be reachable from a fetched URL. */
function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (incl. 100.100.x metadata)
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return true; // unspecified / loopback
    if (low.startsWith("fe80") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) {
      return true; // link-local fe80::/10
    }
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique local fc00::/7
    if (low.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d)
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // not a recognizable IP literal -> refuse
}

const HOSTNAME_ALLOWLIST_LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate a single URL against the policy. Resolves every DNS answer and
 * rejects if ANY resolved address is in a blocked range. Returns the parsed
 * URL and the list of resolved IPs (so a caller can pin the connection).
 */
export async function assertSafeUrl(
  input: string,
  opts: UrlPolicyOptions = {},
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SecurityError(`Not a valid absolute URL: ${input}`);
  }

  const allowInsecure = opts.allowInsecure ?? false;

  if (url.protocol !== "https:") {
    const localHttpOk =
      allowInsecure &&
      url.protocol === "http:" &&
      HOSTNAME_ALLOWLIST_LOCAL.has(url.hostname);
    if (!localHttpOk) {
      throw new SecurityError(
        `Only https:// URLs are allowed (got ${url.protocol}//). ` +
          `Plain http is permitted only for localhost in development.`,
      );
    }
  }

  if (url.username || url.password) {
    throw new SecurityError("URLs must not contain embedded credentials.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Literal IP in the URL - check directly.
  if (net.isIP(host)) {
    if (isBlockedIp(host) && !allowInsecure) {
      throw new SecurityError(`Blocked IP address in URL: ${host}`);
    }
    return { url, addresses: [host] };
  }

  if (allowInsecure && HOSTNAME_ALLOWLIST_LOCAL.has(host)) {
    return { url, addresses: ["127.0.0.1"] };
  }

  const resolver =
    opts.resolve ??
    (async (hostname: string) => {
      const results = await dnsLookup(hostname, { all: true });
      return results.map((r) => r.address);
    });

  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (e) {
    throw new SecurityError(
      `DNS resolution failed for ${host}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (addresses.length === 0) {
    throw new SecurityError(`No DNS records for ${host}`);
  }

  for (const ip of addresses) {
    if (isBlockedIp(ip) && !allowInsecure) {
      throw new SecurityError(
        `${host} resolves to a blocked address (${ip}).`,
      );
    }
  }

  return { url, addresses };
}

/** Sanitize a filename derived from an untrusted URL / header. */
export function sanitizeFilename(name: string, fallback = "download"): string {
  const base = name
    .split(/[\\/]/)
    .pop()!
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 128);
  return base || fallback;
}
