/**
 * Claude extraction: licensed manual PDF -> structured procedures
 * (ADR-0004 §3 step 2). The output is a *proposal*: it goes through
 * submitExtraction(), the deterministic verbatim check and the foreman before
 * any engineer sees it.
 *
 *  - Model: claude-opus-5-5 (dense technical PDFs, torque tables, diagrams).
 *  - The whole PDF is sent once per window and marked for prompt caching, so
 *    walking a 300-page manual in page windows re-reads it at cache prices.
 *  - Structured output (zod schema shared with the service) so the result
 *    parses or fails loudly; we never regex model prose.
 *  - Requires ANTHROPIC_API_KEY. Only call this for documents whose licence
 *    permits processing (allow_ai, or a licence written for extraction).
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ExtractedDocumentSchema, type ExtractedDocument, type ExtractionRunInfo } from '../../services/content.js';

export const EXTRACTION_MODEL = 'claude-opus-5-5';

const SYSTEM = `You extract maintenance and repair procedures from agricultural machinery manuals for a dealer's workshop engineers.

Rules, in order of importance:
1. Spec values (torques, pressures, capacities, clearances, intervals) must be copied EXACTLY as printed: same digits, decimal separator, tolerances and unit text. Never convert, round, combine or infer a value. If a value is unclear, leave that spec out.
2. Every step carries the PDF page number (1-based, counting from the first page of the file) where it is printed. Do not use the page number printed in the manual's footer.
3. Use the manual's own wording for instructions where possible; shorten only by removing filler. Keep warnings and cautions verbatim.
4. Only include procedures that START within the requested page window. A procedure that runs past the window's end is still included in full.
5. Part numbers exactly as printed. Role: "replaced" for the part being changed, "consumable" for oils, filters, seals and fixings used up, "may_need" for parts only needed if damaged.
6. If the window contains no procedures (index, specifications table only, diagrams only), return an empty procedures list.`;

export interface ExtractWindowInput {
  pdf: Uint8Array;
  docTitle: string;
  make: string;
  pageFrom: number;
  pageTo: number;
  knownModels?: string[] | undefined;
}

export interface ExtractWindowResult {
  extraction: ExtractedDocument;
  run: ExtractionRunInfo;
  stopReason: string | null;
}

let client: Anthropic | undefined;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set: extraction is disabled');
  client ??= new Anthropic();
  return client;
}

/** Extract the procedures that start in [pageFrom, pageTo]. */
export async function extractWindow(input: ExtractWindowInput): Promise<ExtractWindowResult> {
  const response = await anthropic().messages.parse({
    model: EXTRACTION_MODEL,
    max_tokens: 32000,
    output_config: { effort: 'high', format: zodOutputFormat(ExtractedDocumentSchema) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(input.pdf).toString('base64') },
            title: input.docTitle,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: [
              `Manufacturer: ${input.make}.`,
              input.knownModels?.length ? `Machine models in the dealer's register for this make: ${input.knownModels.join(', ')}. Use these exact names in "model" where a procedure is model-specific.` : '',
              `Extract every procedure that starts on PDF pages ${input.pageFrom} to ${input.pageTo}.`,
            ].filter(Boolean).join('\n'),
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('Extraction refused by the model');
  if (response.stop_reason === 'max_tokens') throw new Error(`Output hit max_tokens for pages ${input.pageFrom}-${input.pageTo}: use a smaller window`);
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Model output did not match the extraction schema');
  return {
    extraction: parsed,
    stopReason: response.stop_reason ?? null,
    run: {
      model: response.model,
      mode: 'sync',
      pageFrom: input.pageFrom,
      pageTo: input.pageTo,
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

/** Page windows for walking a whole manual. 15 pages keeps output well under max_tokens. */
export function pageWindows(pageCount: number, size = 15): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let from = 1; from <= pageCount; from += size) out.push({ from, to: Math.min(pageCount, from + size - 1) });
  return out;
}
