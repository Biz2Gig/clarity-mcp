import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { handleMcpRequest } from "../mcp/http.server";

/** POST (JSON-RPC) and DELETE (session teardown) for the MCP endpoint. */
export async function action({ request }: ActionFunctionArgs) {
  return handleMcpRequest(request);
}

/** GET -> 405 (stateless Streamable HTTP server; no standalone SSE stream). */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleMcpRequest(request);
}
