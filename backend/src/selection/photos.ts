/**
 * Select up to 10 diverse photos from a list of candidate URLs.
 * Simple heuristic: spread across the list. Structure allows plugging in LLM-based selection later.
 */

export interface SelectPhotosInput {
  imageUrls: string[];
  maxCount?: number;
}

export interface SelectPhotosResult {
  selectedUrls: string[];
  logs: string[];
}

const DEFAULT_MAX = 10;

/**
 * Select a diverse set of up to maxCount images.
 * Heuristic: take evenly spaced indices to avoid many similar consecutive shots.
 */
export function selectPhotosForGemini(input: SelectPhotosInput): SelectPhotosResult {
  const maxCount = input.maxCount ?? DEFAULT_MAX;
  const logs: string[] = [];
  const { imageUrls } = input;

  if (imageUrls.length === 0) {
    logs.push("No candidate images to select from.");
    return { selectedUrls: [], logs };
  }

  if (imageUrls.length <= maxCount) {
    logs.push(`Using all ${imageUrls.length} image(s).`);
    return { selectedUrls: [...imageUrls], logs };
  }

  // Deduplicate by URL
  const unique = Array.from(new Set(imageUrls));
  if (unique.length <= maxCount) {
    logs.push(`Using all ${unique.length} unique image(s).`);
    return { selectedUrls: unique, logs };
  }

  // Evenly spread indices
  const indices: number[] = [];
  for (let i = 0; i < maxCount; i++) {
    const index = Math.floor((i * (unique.length - 1)) / (maxCount - 1));
    indices.push(index);
  }
  const selectedUrls = indices.map((i) => unique[i]);
  logs.push(`Selected ${selectedUrls.length} images from ${unique.length} using diversity spread.`);

  return { selectedUrls, logs };
}

/**
 * Placeholder for future LLM-based selection (e.g. pick living room, kitchen, bathroom, etc.).
 * Same interface so it can replace selectPhotosForGemini in the pipeline.
 */
export async function selectPhotosWithLLM(
  _input: SelectPhotosInput & { prompt?: string }
): Promise<SelectPhotosResult> {
  // For now, fall back to heuristic
  return selectPhotosForGemini(_input);
}
