export function loader() {
  return {
    ok: true,
    service: "clarity-mcp",
    endpoint: "/mcp",
    transport: "JSON-RPC 2.0 over HTTP POST",
  };
}

export default function Index() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.5,
        padding: "2rem",
        maxWidth: 680,
      }}
    >
      <h1>clarity-mcp</h1>
      <p>
        An MCP bridge for the{" "}
        <a href="https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api">
          Microsoft Clarity Data Export API
        </a>
        .
      </p>
      <p>
        JSON-RPC endpoint: <code>POST /mcp</code> with header{" "}
        <code>Authorization: Bearer &lt;MCP_BRIDGE_SECRET&gt;</code>.
      </p>
      <p>
        Responses are cached and the upstream 10-calls-per-day limit is tracked;
        see <code>clarity_quota_status</code>.
      </p>
    </main>
  );
}
