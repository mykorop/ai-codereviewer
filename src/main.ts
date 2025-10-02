import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  try {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });
    // @ts-expect-error - response.data is a string when mediaType format is diff
    const diffData: string = response.data;
    console.log(`Retrieved diff, size: ${diffData.length} characters`);
    return diffData;
  } catch (error) {
    console.error("Error fetching diff:", error);
    return null;
  }
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    console.log(`Analyzing file: ${file.to}`);
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      console.log(`AI Response for ${file.to}:`, JSON.stringify(aiResponse));
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          console.log(`Generated ${newComments.length} comments for ${file.to}`);
          comments.push(...newComments);
        }
      }
    }
  }
  console.log(`Total comments generated: ${comments.length}`);
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `You are a code reviewer. Review the following code changes and provide feedback.

IMPORTANT: You must respond with ONLY a valid JSON object in this exact format:
{"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}

Rules:
- If there are issues to address, include them in the "reviews" array
- If the code looks good, return: {"reviews": []}
- Do not give positive comments or compliments
- Do not suggest adding comments to the code
- Write review comments in GitHub Markdown format
- Each review must have a "lineNumber" (number) and "reviewComment" (string)

Pull Request Context:
Title: ${prDetails.title}
Description: ${prDetails.description || "No description provided"}

File: ${file.to}

Code Changes:
\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`

Respond with ONLY the JSON object, no other text:`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    max_completion_tokens: 700,
  };

  let res = "{}";
  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    res = response.choices[0].message?.content?.trim() || "{}";
    console.log("Raw AI Response:", res.substring(0, 500)); // Log first 500 chars
    
    // Try to extract JSON from the response if it's wrapped in markdown or text
    let jsonStr = res;
    const jsonMatch = res.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const parsed = JSON.parse(jsonStr);
    console.log("Parsed AI Response:", JSON.stringify(parsed));
    return parsed.reviews || [];
  } catch (error) {
    console.error("Error in getAIResponse:", error);
    console.error("Failed response text:", res.substring(0, 500));
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  console.log(`Event action: ${eventData.action}`);

  // Always get the full PR diff, not just incremental changes
  if (eventData.action === "opened" || eventData.action === "synchronize") {
    console.log(`Fetching full PR diff for PR #${prDetails.pull_number}...`);
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else {
    console.log("Unsupported event:", eventData.action);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  console.log(`Diff size: ${diff.length} characters`);

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  console.log(`Found ${parsedDiff.length} files in diff, ${filteredDiff.length} after filtering`);
  console.log(`Files to analyze: ${filteredDiff.map(f => f.to).join(", ")}`);

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    console.log(`Posting ${comments.length} review comments...`);
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
    console.log("Review comments posted successfully!");
  } else {
    console.log("No issues found - code looks good! ✓");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
