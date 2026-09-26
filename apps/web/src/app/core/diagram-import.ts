import { parseDiagram, type ParseResult } from '@keel/shared';

/**
 * Generous for a diagram (the 500-node limit is roughly 300 KB as JSON) while
 * refusing to read something like a video someone picked by mistake into memory.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Read and validate a diagram file the user picked. Never throws. */
export async function readDiagramFile(file: File): Promise<ParseResult> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, errors: [`${file.name} is larger than 5 MB, which is far beyond any diagram.`] };
  }
  try {
    return parseDiagram(await file.text());
  } catch {
    return { ok: false, errors: [`${file.name} could not be read.`] };
  }
}

/** The picked file from an <input type="file"> change event, clearing it so the same file can be picked again. */
export function takePickedFile(event: Event): File | null {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = '';
  return file;
}
