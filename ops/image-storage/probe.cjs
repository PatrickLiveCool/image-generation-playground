// Non-billable integration probe: real COS and public asset delivery, synthetic images only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const publicOrigin = 'https://image.qintopia.cn';
const reportPath = path.join(root, '.local-ops/image-storage/app-probe.json');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cos-probe-'));
const runs = [];
let stage = 'setup';
let generatorCalls = 0;
let blockedModelCalls = 0;

class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function check(condition, code) {
  if (!condition) throw new ProbeError(code);
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(reportPath, 0o600);
}

(async () => {
  // Read only the storage configuration. Credentials never enter generated files or reports.
  const storageKeys = new Set(['COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_DOMAIN', 'CDN_AUTH_KEY', 'ASSET_ACCESS_SECRET']);
  for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !storageKeys.has(match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'));
  for (const name of ['provider-network', 'relay-image', 'cos-assets', 'stored-generation']) {
    const source = fs.readFileSync(path.join(root, 'lib', name + '.ts'), 'utf8');
    fs.writeFileSync(path.join(scratch, name + '.js'), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
  }

  // Fail closed even if someone accidentally removes the injected synthetic generator below.
  const forbidModelCall = async () => { blockedModelCalls++; throw new ProbeError('real_model_call_blocked'); };
  const network = require(path.join(scratch, 'provider-network.js'));
  network.publicFetch = forbidModelCall;
  const relay = require(path.join(scratch, 'relay-image.js'));
  relay.generateRelayImage = forbidModelCall;
  const { createCosStore, readCosConfig, readOwnedAsset } = require(path.join(scratch, 'cos-assets.js'));
  const { generateAndStore } = require(path.join(scratch, 'stored-generation.js'));
  const COS = require('cos-nodejs-sdk-v5');
  const config = readCosConfig();
  const store = createCosStore(config);
  const client = new COS({ SecretId: config.secretId, SecretKey: config.secretKey, Protocol: 'https:', Timeout: 60_000 });
  const png = relay.imageBytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64'));
  const expectedBytes = Buffer.from(png.bytes);
  const expectedDigest = digest(expectedBytes);
  const settings = { baseUrl: 'https://unused.invalid/v1', apiKey: 'synthetic-not-sent', apiMode: 'images' };
  const creationId = crypto.randomUUID();
  const v1Id = crypto.randomUUID();
  const v2Id = crypto.randomUUID();
  const firstPrompt = 'Object storage verification: create V1.';
  const secondPrompt = 'Object storage verification: modify V1 into V2.';

  async function syntheticGenerator(_settings, input) {
    generatorCalls++;
    check(generatorCalls <= 2, 'unexpected_generator_count');
    check(input.images.length === 1 && Buffer.from(input.images[0].bytes).equals(expectedBytes), 'generator_base_mismatch');
    if (generatorCalls === 1) check(input.prompt === firstPrompt, 'initial_prompt_changed');
    else {
      check(input.prompt.startsWith('以第一张图片为编辑基准'), 'edit_instruction_missing');
      check(input.prompt.endsWith(secondPrompt) && !input.prompt.includes(firstPrompt), 'edit_prompt_replay');
    }
    return png;
  }

  function imageLocation(result) {
    check(typeof result.url === 'string' && result.url.startsWith('/api/assets/'), 'unexpected_asset_path');
    const url = new URL(result.url, publicOrigin);
    check(url.origin === publicOrigin, 'unexpected_asset_origin');
    const key = url.pathname.slice('/api/assets/'.length);
    check(key === `image-playground/runs/${result.runId}/outputs/final.png`, 'output_key_mismatch');
    return { url, key, manifestKey: `image-playground/runs/${result.runId}/manifest.json` };
  }

  async function readManifest(key) {
    const bytes = await new Promise((resolve, reject) => {
      client.getObject({ Bucket: config.bucket, Region: config.region, Key: key }, (error, data) => {
        if (error || !Buffer.isBuffer(data?.Body)) reject(new ProbeError('manifest_read_failed'));
        else resolve(data.Body);
      });
    });
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); }
    catch { throw new ProbeError('manifest_json_invalid'); }
    return { manifest, sha256: digest(bytes) };
  }

  async function verifyStoredRun(result, prompt, lineage, hasBaseImage) {
    const location = imageLocation(result);
    const { manifest, sha256: manifestSha256 } = await readManifest(location.manifestKey);
    check(manifest.version === 1 && manifest.runId === result.runId && manifest.status === 'complete', 'manifest_incomplete');
    check(manifest.mode === 'image-editing' && manifest.inputs?.length === 1, 'manifest_inputs_mismatch');
    check(manifest.prompt?.text === prompt && manifest.prompt.length === prompt.length && manifest.prompt.sha256 === digest(prompt), 'manifest_prompt_mismatch');
    check(manifest.lineage && Object.entries(lineage).every(([key, value]) => manifest.lineage[key] === value), 'manifest_lineage_mismatch');
    check(Object.entries(lineage).every(([key, value]) => result[key] === value), 'result_lineage_mismatch');
    check(manifest.baseInputKey === (hasBaseImage ? manifest.inputs[0].key : null), 'manifest_base_input_mismatch');
    check(manifest.inputs[0].key === `image-playground/runs/${result.runId}/inputs/reference-1.png`, 'manifest_input_key_mismatch');
    check(manifest.inputs[0].sha256 === expectedDigest && manifest.output?.key === location.key && manifest.output.sha256 === expectedDigest, 'manifest_image_hash_mismatch');
    const serialized = JSON.stringify(manifest);
    for (const forbidden of [settings.apiKey, settings.baseUrl, config.secretId, config.secretKey, config.assetAccessSecret, config.cdnAuthKey, result.url]) {
      check(!serialized.includes(forbidden), 'manifest_contains_private_configuration');
    }
    const input = await store.getImage(manifest.inputs[0].key);
    const output = await store.getImage(manifest.output.key);
    check(Buffer.from(input.bytes).equals(expectedBytes) && Buffer.from(output.bytes).equals(expectedBytes), 'cos_image_readback_mismatch');
    const run = {
      runId: result.runId, version: lineage.version,
      cosInputStatus: 'verified', cosOutputStatus: 'verified', manifestStatus: 'verified', lineageStatus: 'verified', baseInputStatus: 'verified',
      inputSha256: digest(input.bytes), outputSha256: digest(output.bytes), promptSha256: manifest.prompt.sha256, manifestSha256,
    };
    runs.push(run);
    return { location, run };
  }

  let verifiedRuns;
  if (process.argv.includes('--public-only')) {
    stage = 'restore_verified_cos_report';
    const prior = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    check(prior.realModelRequests === 0 && prior.generatorCalls === 2 && prior.runs?.length === 2, 'missing_verified_cos_report');
    for (const run of prior.runs) {
      check(run.cosInputStatus === 'verified' && run.cosOutputStatus === 'verified' && run.manifestStatus === 'verified' && run.lineageStatus === 'verified' && run.outputSha256 === expectedDigest, 'unverified_prior_cos_result');
      check(/^[0-9a-f-]{36}$/.test(run.runId), 'invalid_prior_run_id');
      runs.push(run);
    }
    generatorCalls = prior.generatorCalls;
    verifiedRuns = runs.map(run => ({
      run,
      location: imageLocation({runId: run.runId, url: store.assetUrl(`image-playground/runs/${run.runId}/outputs/final.png`)}),
    }));
  } else {
    stage = 'create_v1';
    const v1Lineage = { creationId, clientVersionId: v1Id, parentVersionId: null, version: 1 };
    const v1 = await generateAndStore(settings, {
      model: 'storage-connectivity-probe', prompt: firstPrompt, aspectRatio: 'square', quality: 'auto', images: [png], lineage: v1Lineage,
    }, store, undefined, syntheticGenerator);
    stage = 'verify_cos_v1';
    const verifiedV1 = await verifyStoredRun(v1, firstPrompt, v1Lineage, false);

    stage = 'read_v1_base';
    const base = await readOwnedAsset(v1.url, store);
    check(base && Buffer.from(base.bytes).equals(expectedBytes), 'owned_base_readback_mismatch');
    stage = 'create_v2';
    const v2Lineage = { creationId, clientVersionId: v2Id, parentVersionId: v1Id, version: 2 };
    const v2 = await generateAndStore(settings, {
      model: 'storage-connectivity-probe', prompt: secondPrompt, aspectRatio: 'square', quality: 'auto', images: [base], hasBaseImage: true, lineage: v2Lineage,
    }, store, undefined, syntheticGenerator);
    stage = 'verify_cos_v2';
    const verifiedV2 = await verifyStoredRun(v2, secondPrompt, v2Lineage, true);
    verifiedRuns = [verifiedV1, verifiedV2];
  }

  for (const { location, run } of verifiedRuns) {
    stage = `verify_public_v${run.version}`;
    const response = await fetch(location.url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    run.assetStatus = response.status;
    check(response.status === 200 && !response.headers.get('location'), 'asset_direct_delivery_failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    check(bytes.equals(expectedBytes), 'public_image_readback_mismatch');
    run.publicSha256 = digest(bytes);

    const invalidUrl = new URL(location.url);
    invalidUrl.search = '?access=invalid';
    const denied = await fetch(invalidUrl, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    run.invalidCapabilityStatus = denied.status;
    await denied.body?.cancel();
    check(denied.status === 403, 'invalid_capability_accepted');

    // A correctly signed token for a forbidden manifest key tests the image-only allowlist.
    const manifestUrl = new URL(`/api/assets/${location.manifestKey}`, publicOrigin);
    const token = crypto.createHmac('sha256', config.assetAccessSecret).update(`image-playground:asset:v1\0${location.manifestKey}`).digest('base64url');
    manifestUrl.searchParams.set('access', token);
    const metadata = await fetch(manifestUrl, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    run.assetManifestStatus = metadata.status;
    await metadata.body?.cancel();
    check(metadata.status === 403, 'manifest_exposed_through_asset_route');
  }

  check(generatorCalls === 2 && blockedModelCalls === 0, 'unexpected_model_call');
  const report = {
    verifiedAt: new Date().toISOString(), status: 'verified', runId: runs[runs.length - 1].runId, runs,
    generatorCalls, realModelRequests: 0, blockedModelCalls,
    cosReferenceAndResultHashesMatch: true, publicResultHashesMatch: true, manifestComplete: true,
  };
  stage = 'write_report';
  writeReport(report);
  console.log(JSON.stringify(report));
})().catch(error => {
  // Never emit exception messages, request URLs, SDK response bodies, or credentials.
  const report = {
    verifiedAt: new Date().toISOString(), status: 'failed', probeFailed: true, stage,
    errorCode: error instanceof ProbeError ? error.code : 'probe_operation_failed',
    runs, generatorCalls, realModelRequests: 0, blockedModelCalls,
  };
  try { writeReport(report); } catch { /* Console output remains safe if the report cannot be written. */ }
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}).finally(() => fs.rmSync(scratch, { recursive: true, force: true }));
