# MCP design

MCP is the product's front door for AI, not an add-on. A dealer's own agent, Claude, or a reseller's assistant can work the parts counter through the same rules as the UI.

## Transports

- **stdio**: `src/mcp/stdio.ts`. Identity comes from `AGRIPARTS_API_KEY`. For Claude Desktop / Claude Code on a dealer workstation.
- **Streamable HTTP**: `POST /mcp` on the API server, stateless (a new server per request), bearer API key. For remote and hosted clients.

## Tools

| Tool | Scope(s) | Kind |
|---|---|---|
| `search_parts` | parts:read | read |
| `resolve_part_number` | parts:read | read: supersession chain, fitting warning, equivalents, stock |
| `check_availability` | stock:read | read |
| `get_price` | parts:read, customers:read | read: customer-specific, with reason. Cost and margin only shown with insights:read |
| `find_customer`, `get_customer` | customers:read | read |
| `get_order`, `list_backorders` | orders:read | read |
| `list_depots` | parts:read | read |
| `reorder_suggestions`, `rebalance_suggestions`, `dead_stock` | insights:read | read |
| `create_quote` | orders:write, customers:read | write, no stock effect |
| `confirm_order` | orders:write | **two-phase** |
| `transfer_stock` | stock:write | **two-phase** |
| `raise_purchase_order` | purchasing:write, insights:read | **two-phase**, draft only |

Not exposed to agents by design: invoicing, sending POs to suppliers, stock adjustments, imports. A human does those in the UI or over REST.

Prompts: `counter_assistant` (operating rules) and `morning_parts_review`. Resources: `agriparts://depots` and `agriparts://parts/{make}/{partNumber}`.

## Safety model

1. **Scoped visibility.** The server is built per principal. Tools the key can't use are never listed, so a read-only analyst key can't see `confirm_order`.
2. **Two-phase writes.** Calling a write tool without `confirmation_code` returns `PREVIEW_ONLY_NOTHING_CHANGED`, a human-readable preview and a code. The code is an HMAC over tenant, principal, tool, the exact arguments, a fingerprint of the current state (order totals and allocation, the source depot's free stock) and a 15-minute window. Changed arguments, a different user, changed stock or a stale code are all refused, and the agent is told to preview again. No server-side state is kept.
3. **Explainable outputs.** Prices carry their basis, reorder lines their reasoning, and supersessions their chain and fitting flag. Money is rendered as `£12.34`, not pence, because models misplace decimal points.
4. **Recoverable errors.** Errors are typed (`AMBIGUOUS` lists the candidate makes, `NOT_FOUND` suggests searching), so the model can recover rather than guess.
5. **Every call logged** in `tool_call_log` (principal, tool, arguments, ok, summary, duration). State changes are also in `audit_log` with `channel = 'mcp'`.

## Next

- OAuth 2.1 (MCP authorization spec) so a counter user's own identity, not a shared key, is the principal.
- Per-tenant rate limits on `/mcp`.
- Port the v1 tools: `parts_for_machine`, `find_fitting_instructions` (licensed content only), `predict_parts` (consented telematics).
- `outputSchema` / structured content once the response shapes settle.
