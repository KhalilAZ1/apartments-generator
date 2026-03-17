/**
 * Send images to Google Gemini for modification at TikTok/phone resolution (9:16).
 */

import { GoogleGenerativeAI, Part } from "@google/generative-ai";
import { getConfig } from "../config/env";

const OUTPUT_ASPECT_RATIO = "9:16";
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;

/** Allowed model IDs – must support image *output* (not just input). */
export const GEMINI_IMAGE_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
] as const;
export type GeminiImageModelId = (typeof GEMINI_IMAGE_MODELS)[number];

/** USD per generated image (standard tier, ~1K resolution). From Google Gemini API pricing. */
export const COST_PER_IMAGE_USD: Record<GeminiImageModelId, number> = {
  "gemini-2.5-flash-image": 0.039,
  "gemini-3.1-flash-image-preview": 0.067,
  "gemini-3-pro-image-preview": 0.134,
};

export interface GeminiResult {
  success: boolean;
  imageBuffer: Buffer | null;
  errorMessage: string | null;
  /** Estimated cost in USD for this single image (when success). */
  costUsd?: number;
}

/**
 * Process a single image with Gemini: pass image + prompt, get modified image back.
 * If the API returns image bytes, return them; otherwise return error.
 * @param modelId - One of GEMINI_IMAGE_MODELS; defaults to gemini-2.5-flash-image (Nano Banana).
 */
export async function processImageWithGemini(
  imageBuffer: Buffer,
  mimeType: string,
  prompt: string,
  logs: string[] = [],
  modelId: GeminiImageModelId = "gemini-2.5-flash-image",
  styleReference?: { buffer: Buffer; mimeType: string }
): Promise<GeminiResult> {
  const addLog = (msg: string) => logs.push(`[Gemini] ${msg}`);

  try {
    const config = getConfig();
    const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

    addLog(`Using model: ${modelId}`);
    // Request image output; without this the model may return only text.
    const model = genAI.getGenerativeModel({
      model: modelId,
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] } as import("@google/generative-ai").GenerationConfig,
    });

    const imagePart: Part = {
      inlineData: {
        mimeType: mimeType as "image/jpeg" | "image/png" | "image/webp",
        data: imageBuffer.toString("base64"),
      },
    };

    // Use the prompt exactly as sent from the frontend (no extra text added).
    const fullPrompt = prompt;

    const partsToSend: Part[] = [];
    // If provided, include a style reference image so multiple outputs keep a consistent look.
    if (styleReference) {
      const refPart: Part = {
        inlineData: {
          mimeType: styleReference.mimeType as "image/jpeg" | "image/png" | "image/webp",
          data: styleReference.buffer.toString("base64"),
        },
      };
      partsToSend.push(
        {
          text:
            "Style reference: match the overall look/grade/style of this reference image while still editing the current input image realistically.",
        } as unknown as Part
      );
      partsToSend.push(refPart);
    }
    partsToSend.push({ text: fullPrompt } as unknown as Part);
    partsToSend.push(imagePart);

    addLog(
      `Sending to Gemini: ${styleReference ? "2 images (style ref + input)" : "1 image"}; input ${(imageBuffer.length / 1024).toFixed(1)} KB (${mimeType})`
    );
    addLog(`Prompt (${fullPrompt.length} chars): "${fullPrompt.replace(/\n/g, " ").slice(0, 300)}${fullPrompt.length > 300 ? "…" : ""}"`);

    const result = await model.generateContent(partsToSend);
    const response = result.response;

    if (!response.candidates || response.candidates.length === 0) {
      const blockReason = response.promptFeedback?.blockReason ?? "Unknown";
      addLog(`No candidate; blockReason: ${blockReason}`);
      return {
        success: false,
        imageBuffer: null,
        errorMessage: `Gemini returned no result (${blockReason}).`,
      };
    }

    const candidate = response.candidates[0];
    const parts = candidate.content?.parts ?? [];

    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        const buffer = Buffer.from(part.inlineData.data, "base64");
        const costUsd = COST_PER_IMAGE_USD[modelId];
        addLog(`Received image buffer, size ${buffer.length}`);
        return { success: true, imageBuffer: buffer, errorMessage: null, costUsd };
      }
    }

    // Gemini 1.5 Flash might return text only; then we don't have image output.
    // In that case we could use Imagen or a dedicated image-gen endpoint if available.
    addLog("Response contained no inline image data.");
    return {
      success: false,
      imageBuffer: null,
      errorMessage: "Gemini did not return an image. The model may not support image output in this configuration.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(`Error: ${message}`);
    return {
      success: false,
      imageBuffer: null,
      errorMessage: message,
    };
  }
}

/**
 * Download image from URL to buffer. Returns null on failure.
 */
export async function downloadImage(url: string, logs: string[] = []): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const addLog = (msg: string) => logs.push(`[Download] ${msg}`);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ListingImageProcessor/1.0)" } });
    if (!res.ok) {
      addLog(`HTTP ${res.status} for ${url}`);
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const mimeType = contentType.split(";")[0].trim();
    addLog(`Downloaded ${buffer.length} bytes, ${mimeType}`);
    return { buffer, mimeType };
  } catch (err) {
    addLog(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
