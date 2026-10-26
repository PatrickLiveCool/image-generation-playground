import assert from "node:assert/strict";
import test from "node:test";
import { dispatchReleaseChecks, githubRequest, validateDispatchTarget } from "./release-pr-checks.mjs";

const repository = "PatrickLiveCool/image-generation-playground";
const sha = "a".repeat(40);
function pull() {
  return { number: 12, state: "open", title: "chore(release): release 0.2.0", head: { ref: "release-please--branches--master", sha, repo: { full_name: repository } }, base: { ref: "master", repo: { full_name: repository } } };
}

function fixture(current = pull()) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST") return null;
    return path.includes("?") ? (current ? [current] : []) : current;
  };
  return { calls, request };
}

test("dispatch uses live same-repository metadata, never an action-output branch", async () => {
  const { calls, request } = fixture();
  const result = await dispatchReleaseChecks({ repository, prsJson: JSON.stringify([{ number: 12, headBranchName: "untrusted-branch", sha: "b".repeat(40) }]), request });
  const posts = calls.filter(call => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(call => call.path), [`/repos/${repository}/actions/workflows/ci.yml/dispatches`, `/repos/${repository}/actions/workflows/pr-format.yml/dispatches`]);
  assert.deepEqual(posts[0].body, { ref: "release-please--branches--master", inputs: { pull_request_number: "12", expected_head_sha: sha } });
  assert.deepEqual(result, [{ number: 12, headSha: sha, checksRequested: ["ci.yml", "pr-format.yml"] }]);
  assert.equal("passed" in result[0], false);
});

test("an unchanged release PR can explicitly retry checks using its current metadata", async () => {
  const { calls, request } = fixture();
  await dispatchReleaseChecks({ repository, request });
  assert.match(calls[0].path, /state=open&base=master&head=PatrickLiveCool%3Arelease-please--branches--master/);
  assert.equal(calls.filter(call => call.method === "POST").length, 2);
});

test("a run with no current release PR dispatches no empty replacement checks", async () => {
  const { calls, request } = fixture(null);
  assert.deepEqual(await dispatchReleaseChecks({ repository, request }), []);
  assert.equal(calls.length, 1);
});

test("forks, unrelated branches and invalid release identities cannot dispatch workflows", async () => {
  for (const mutate of [p => { p.head.repo.full_name = "someone/else"; }, p => { p.base.repo.full_name = "someone/else"; }, p => { p.base.ref = "other"; }, p => { p.head.ref = "feature"; }, p => { p.head.sha = "bad"; }, p => { p.title = "fix: unrelated change"; }]) {
    const current = pull(); mutate(current);
    const { calls, request } = fixture(current);
    await assert.rejects(dispatchReleaseChecks({ repository, prJson: '{"number":12}', request }));
    assert.equal(calls.filter(call => call.method === "POST").length, 0);
  }
});

test("closed PRs are skipped and malformed action output fails closed", async () => {
  const closed = pull(); closed.state = "closed";
  const { calls, request } = fixture(closed);
  assert.deepEqual(await dispatchReleaseChecks({ repository, prsJson: '[{"number":12}]', request }), [{ number: 12, skipped: "closed" }]);
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
  for (const prsJson of ["bad JSON", "{}", '[{"number":"12; injected"}]', '[{"number":0}]']) {
    await assert.rejects(dispatchReleaseChecks({ repository, prsJson, request }));
  }
});

test("dispatched jobs reject a stale SHA or a different workflow ref", async () => {
  const { request } = fixture();
  const input = { repository, number: "12", expectedSha: sha, currentSha: sha, currentRef: "release-please--branches--master", request };
  assert.deepEqual(await validateDispatchTarget(input), { number: 12, headSha: sha });
  await assert.rejects(validateDispatchTarget({ ...input, currentSha: "b".repeat(40) }));
  await assert.rejects(validateDispatchTarget({ ...input, currentRef: "master" }));
  const advanced = pull(); advanced.head.sha = "b".repeat(40);
  await assert.rejects(validateDispatchTarget({ ...input, request: fixture(advanced).request }));
});

test("GitHub transport posts JSON and does not leak private failure responses", async () => {
  const observations = [];
  const request = githubRequest("secret-token", async (url, options) => { observations.push({ url, options }); return new Response(null, { status: 204 }); });
  await request("POST", `/repos/${repository}/actions/workflows/ci.yml/dispatches`, { ref: "release-please--branches--master" });
  assert.equal(observations[0].options.headers.authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(observations[0].options.body), { ref: "release-please--branches--master" });
  assert.equal(observations[0].options.redirect, "error");
  const failed = githubRequest("secret-token", async () => new Response("private response and secret-token", { status: 403 }));
  await assert.rejects(failed("GET", `/repos/${repository}/pulls/12`), error => error.message === "GitHub GET request failed with status 403.");
});
