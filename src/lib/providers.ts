/**
 * Two ways to get structured JSON out of Bedrock.
 *
 * The pipeline doesn't care which model does the extraction, so the model call
 * is isolated behind one function. Which backend runs is decided by the model
 * id alone — nothing else in the codebase changes when you switch.
 *
 *   anthropic.*   -> Messages API via the Mantle endpoint, using
 *                    `output_config.format` for schema-constrained output.
 *   anything else -> the Converse API, using a single forced tool call to get
 *                    the same guarantee. Works with Nova, Llama, Mistral, etc.
 *
 * Converse is the lowest common denominator across Bedrock; the Anthropic path
 * is kept because structured outputs are a first-class feature there rather
 * than a tool-call workaround.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { bedrock, MODEL_ID, BEDROCK_REGION } from "./aws";

const converseClient = new BedrockRuntimeClient({ region: BEDROCK_REGION });

/** The tool name is arbitrary; it only has to be stable within a request. */
const TOOL_NAME = "record_extraction";

export function isAnthropicModel(modelId = MODEL_ID): boolean {
  return modelId.startsWith("anthropic.");
}

/**
 * Send a prompt, get back an object matching `schema`.
 *
 * Both paths constrain the model to the schema rather than asking it politely
 * for JSON, so callers never have to strip markdown fences or repair output.
 */
export async function generateStructured(
  prompt: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  return isAnthropicModel()
    ? viaAnthropicMessages(prompt, schema)
    : viaConverse(prompt, schema);
}

async function viaAnthropicMessages(
  prompt: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  const response = await bedrock.messages.create({
    model: MODEL_ID,
    max_tokens: 8000,
    // Extraction is well-scoped with the answer sitting in the context, so low
    // effort is cheaper and faster at no measurable accuracy cost here.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema },
    },
    messages: [{ role: "user", content: prompt }],
  });

  // Safety classifiers can decline a request; that arrives as a 200 with an
  // empty content array, so check before indexing into it.
  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to process this document.");
  }

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Model returned no text content.");
  }

  return JSON.parse(block.text);
}

async function viaConverse(
  prompt: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  const tool: Tool = {
    toolSpec: {
      name: TOOL_NAME,
      description:
        "Record the classification and extracted fields for this document.",
      // The SDK types `json` as a Smithy Document (an open recursive union).
      // A plain JSON-Schema object satisfies it structurally but not
      // nominally, so cast rather than contort the schema builder.
      inputSchema: { json: schema as unknown as DocumentType },
    },
  };

  const res = await converseClient.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      // Forcing the tool is what makes the output structured. Some models
      // reject a forced tool choice, so fall back to offering it and relying
      // on the prompt — see the catch below.
      toolConfig: { tools: [tool], toolChoice: { tool: { name: TOOL_NAME } } },
      inferenceConfig: { maxTokens: 8000, temperature: 0 },
    }),
  ).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!/toolChoice|not support/i.test(message)) throw err;

    return converseClient.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        messages: [{ role: "user", content: [{ text: prompt }] }],
        toolConfig: { tools: [tool] },
        inferenceConfig: { maxTokens: 8000, temperature: 0 },
      }),
    );
  });

  const blocks = res.output?.message?.content ?? [];
  const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
  if (toolUse?.input) return toolUse.input;

  // Some models answer in prose despite the tool being offered. Recover the
  // JSON rather than failing the whole document.
  const text = blocks.find((b) => b.text)?.text;
  if (text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  }

  throw new Error(
    `${MODEL_ID} returned no structured output. stopReason=${res.stopReason}`,
  );
}
