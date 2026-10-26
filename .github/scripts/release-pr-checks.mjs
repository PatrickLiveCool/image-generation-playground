import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_BRANCH = "release-please--branches--master";
const WORKFLOWS = ["ci.yml", "pr-format.yml"];
const SHA = /^[0-9a-f]{40}$/;

function repositoryName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Invalid GitHub repository.");
  return value;
}

function prNumber(value) {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(number)) throw new Error("Release PR number must be a positive integer.");
  return number;
}

export function validateReleasePullRequest(pull, repository) {
  repositoryName(repository);
  if (!pull || typeof pull !== "object" || pull.state !== "open") throw new Error("Release PR must still be open.");
  prNumber(pull.number);
  const repo = repository.toLowerCase();
  if (pull.head?.repo?.full_name?.toLowerCase() !== repo || pull.base?.repo?.full_name?.toLowerCase() !== repo) throw new Error("Release PR must belong to this repository; forks are not dispatched.");
  if (pull.base?.ref !== "master" || pull.head?.ref !== RELEASE_BRANCH || !SHA.test(pull.head?.sha ?? "")) throw new Error("Unexpected release PR branch or commit.");
  if (!/^chore\(release\): release (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pull.title ?? "")) throw new Error("Unexpected release PR title.");
  return { number: pull.number, branch: pull.head.ref, sha: pull.head.sha };
}

function outputNumbers(prsJson, prJson) {
  if (!prsJson && !prJson) return null;
  let candidates;
  try { candidates = prsJson ? JSON.parse(prsJson) : [JSON.parse(prJson)]; }
  catch { throw new Error("Release Please PR output is not valid JSON."); }
  if (!Array.isArray(candidates) || candidates.length > 20) throw new Error("Unexpected Release Please PR output.");
  return [...new Set(candidates.map(pull => prNumber(pull?.number)))];
}

export async function dispatchReleaseChecks({ repository, prsJson = "", prJson = "", request }) {
  repositoryName(repository);
  let numbers = outputNumbers(prsJson, prJson);
  // Release Please emits no PR output when its contents did not change. A manual
  // rerun may still retry the checks of the current, precisely named release PR.
  if (numbers === null || numbers.length === 0) {
    const query = new URLSearchParams({ state: "open", base: "master", head: `${repository.split("/")[0]}:${RELEASE_BRANCH}`, per_page: "100" });
    const current = await request("GET", `/repos/${repository}/pulls?${query}`);
    if (!Array.isArray(current) || current.length > 1) throw new Error("Could not identify a unique current release PR.");
    numbers = current.map(pull => prNumber(pull.number));
  }
  const results = [];
  for (const number of numbers) {
    // Action output is only a lookup hint. Always revalidate live PR metadata.
    const pull = await request("GET", `/repos/${repository}/pulls/${number}`);
    if (pull?.state === "closed") { results.push({ number, skipped: "closed" }); continue; }
    const target = validateReleasePullRequest(pull, repository);
    if (target.number !== number) throw new Error("GitHub returned an unexpected release PR number.");
    for (const workflow of WORKFLOWS) {
      await request("POST", `/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
        ref: target.branch,
        inputs: { pull_request_number: String(number), expected_head_sha: target.sha },
      });
    }
    results.push({ number, headSha: target.sha, checksRequested: [...WORKFLOWS] });
  }
  return results;
}

export async function validateDispatchTarget({ repository, number, expectedSha, currentSha, currentRef, request }) {
  repositoryName(repository);
  if (!SHA.test(expectedSha ?? "") || expectedSha !== currentSha) throw new Error("Dispatched commit no longer matches the expected release PR commit.");
  const pull = await request("GET", `/repos/${repository}/pulls/${prNumber(number)}`);
  const target = validateReleasePullRequest(pull, repository);
  if (target.number !== prNumber(number)) throw new Error("GitHub returned an unexpected release PR number.");
  if (target.sha !== expectedSha || target.branch !== currentRef) throw new Error("Release PR changed after dispatch; rerun Release Please to request checks for the new commit.");
  return { number: target.number, headSha: target.sha };
}

export function githubRequest(token, fetchImplementation = fetch) {
  if (!token) throw new Error("GitHub token is required.");
  return async (method, path, body) => {
    const response = await fetchImplementation(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    // Do not echo GitHub response bodies, request headers or token material.
    if (!response.ok) throw new Error(`GitHub ${method} request failed with status ${response.status}.`);
    return response.status === 204 ? null : response.json();
  };
}

export async function main(environment = process.env, mode = process.argv[2]) {
  const request = githubRequest(environment.GH_TOKEN);
  if (mode === "dispatch") return dispatchReleaseChecks({ repository: environment.GITHUB_REPOSITORY, prsJson: environment.RELEASE_PRS_JSON, prJson: environment.RELEASE_PR_JSON, request });
  if (mode === "validate") return validateDispatchTarget({ repository: environment.GITHUB_REPOSITORY, number: environment.RELEASE_PR_NUMBER, expectedSha: environment.EXPECTED_HEAD_SHA, currentSha: environment.GITHUB_SHA, currentRef: environment.GITHUB_REF_NAME, request });
  throw new Error("Use dispatch or validate.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`Release PR checks: ${error.message}`);
    process.exitCode = 1;
  });
}
