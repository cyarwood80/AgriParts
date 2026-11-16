/**
 * Per-page text layer of a PDF (pdf.js via unpdf, pure JS, runs in Node and
 * Workers). Scanned manuals with no text layer come back as empty pages; they
 * need OCR before the verbatim check can pass. The check will say so.
 */
export interface PageText {
  page: number;
  text: string;
}

export async function pdfPageTexts(pdf: Uint8Array): Promise<PageText[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // pdf.js takes ownership of the buffer it's given; pass a copy.
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: false });
  return (text as string[]).map((t, i) => ({ page: i + 1, text: t }));
}
