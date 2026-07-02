import { createProviderRegistry, generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";

// App-layer LLM (distinct from the Cognee engine's own LLM). Used for decision
// extraction during ingest and PR-resemblance judgment during catch.
const registry = createProviderRegistry({ google, openai, deepseek });

type ModelId = `google:${string}` | `openai:${string}` | `deepseek:${string}`;

const DEFAULT_MODEL: Record<string, ModelId> = {
  google: `google:${process.env.CODEGUARD_GOOGLE_MODEL ?? "gemini-2.5-flash"}`,
  openai: `openai:${process.env.CODEGUARD_OPENAI_MODEL ?? "gpt-4o-mini"}`,
  deepseek: `deepseek:${process.env.CODEGUARD_DEEPSEEK_MODEL ?? "deepseek-chat"}`,
};

function model(provider: string) {
  return registry.languageModel(DEFAULT_MODEL[provider] ?? DEFAULT_MODEL.google);
}

const decisionSchema = z.object({
  isDecision: z.boolean().describe("true only if this thread records a real maintainer decision or rejection"),
  title: z.string(),
  outcome: z.enum(["accepted", "rejected", "reverted"]),
  reasoning: z.string().describe("why the decision was made, one or two sentences"),
  terms: z.array(z.string()).describe("key nouns: dependencies, file paths, tools, labels"),
  supersedesRefs: z
    .array(z.string())
    .describe("references to prior issues/PRs this decision reverses or supersedes, e.g. '#42', 'DR-11'; empty if none"),
});

export type ExtractedDecision = z.infer<typeof decisionSchema>;

export async function extractDecision(provider: string, thread: string): Promise<ExtractedDecision> {
  const { object } = await generateObject({
    model: model(provider),
    schema: decisionSchema,
    prompt: `From the following GitHub issue/PR thread, extract the maintainer decision if one exists.\n\n${thread}`,
  });
  return object;
}

const judgmentSchema = z.object({
  matches: z.boolean(),
  decisionId: z.string().nullable().describe("the decision_id this PR re-proposes, or null"),
  comment: z.string().describe("a short PR comment citing the decision, or empty when there is no match"),
});

export type Judgment = z.infer<typeof judgmentSchema>;

export async function judgePr(
  provider: string,
  prText: string,
  candidates: { decisionId: string; title: string; outcome: string; reasoning: string; url: string }[],
  memoryContext: string,
  customInstructions: string,
): Promise<Judgment> {
  const list = candidates
    .map((c) => `- ${c.decisionId} [${c.outcome}] ${c.title}: ${c.reasoning} (${c.url})`)
    .join("\n");
  const { object } = await generateObject({
    model: model(provider),
    schema: judgmentSchema,
    prompt:
      `${customInstructions}\n\n` +
      `A new pull request:\n${prText}\n\n` +
      `Relevant memory (cited):\n${memoryContext}\n\n` +
      `Candidate past decisions:\n${list}\n\n` +
      `Does this PR re-propose something already REJECTED (and not later reverted)? ` +
      `If yes, set matches=true, cite the decision_id, and draft a short, respectful comment that cites it. ` +
      `If there is no clear match, set matches=false.`,
  });
  return object;
}
