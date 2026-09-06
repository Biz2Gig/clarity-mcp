export function loader() {
  return {
    ok: true,
    service: "clarity-mcp",
    endpoint: "/mcp",
    transport: "Streamable HTTP (JSON-RPC 2.0), stateless JSON mode",
    capabilities: [
      "Clarity aggregate analytics (cached, 10 calls/day)",
      "Clarity recording metadata import from dashboard CSV",
      "Async video ingestion, transcription, keyframe + visual analysis",
      "Timestamp-grounded video summaries and Q&A",
    ],
  };
}

export default function Index() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.55,
        padding: "2rem",
        maxWidth: 720,
      }}
    >
      <h1>clarity-mcp</h1>
      <p>
        MCP server for the{" "}
        <a href="https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api">
          Microsoft Clarity Data Export API
        </a>
        , Clarity recording-metadata import, and asynchronous video analysis.
      </p>
      <p>
        JSON-RPC endpoint: <code>POST /mcp</code> with{" "}
        <code>Authorization: Bearer &lt;MCP_BRIDGE_SECRET&gt;</code>. Protocol
        version is negotiated by the MCP SDK.
      </p>
      <p>
        Clarity session <em>replays</em> are not retrievable through the Data
        Export API. Recording tools import <strong>metadata only</strong> from
        the CSV you export in the Clarity dashboard.
      </p>
      <p>See the README for setup, worker, and tool documentation.</p>
    </main>
  );
}
