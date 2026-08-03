import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  EXIT,
  PacketValidationError,
  SMOKE_PREFIX,
  canonicalJson,
  collectPacket,
  runSmoke,
  validatePacket,
  writePacketAtomic,
} from './driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = resolve(HERE, 'driver.mjs');

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'technical-design-driver-test-'));
  const repo = resolve(root, 'repo');
  const evidencePath = resolve(repo, 'evidence.txt');
  const secondPath = resolve(repo, 'architecture.txt');
  mkdirSync(repo);
  writeFileSync(evidencePath, 'mechanism one\nconstraint two\nverification three\n', 'utf8');
  writeFileSync(secondPath, 'architecture alpha\noverlap beta\n', 'utf8');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { evidencePath, repo, root, secondPath };
}

function collect(repo, evidence = ['mechanism=evidence.txt']) {
  return collectPacket({
    evidence,
    goal: 'Choose the safest local implementation.',
    repo,
  });
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [DRIVER, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function packetFile(root, packet, name = 'packet.json') {
  const path = resolve(root, name);
  writeFileSync(path, canonicalJson(packet), 'utf8');
  return path;
}

function citation(packet) {
  return structuredClone(packet.discussion.currentMechanisms[0].citations[0]);
}

function fact(packet, id, statement = 'The evidence establishes the mechanism.') {
  return { citations: [citation(packet)], classification: 'Fact', id, statement };
}

function inference(packet, id, statement = 'The cited mechanism supports this conclusion.') {
  return { citations: [citation(packet)], classification: 'Inference', id, statement };
}

function unknown(id, statement) {
  return { citations: [], classification: 'Unknown', id, statement };
}

function discussionPacket(repo) {
  const packet = collect(repo);
  packet.stage = 'discussion';
  packet.discussion = {
    constraints: [inference(packet, 'C17', 'The design is constrained to the evidenced local mechanism.')],
    currentMechanisms: [fact(packet, 'C4', 'The evidence records the current local mechanism.')],
    decisions: [
      {
        answer: null,
        id: 'D1',
        question: 'Which evidence-supported implementation option should be selected?',
        rationale: [inference(packet, 'C12', 'The evidence supports comparing both local options.')],
        status: 'unresolved',
      },
    ],
    executablePlan: [],
    goal: [fact(packet, 'C1', 'The evidence grounds the requested local design choice.')],
    localImplementation: [fact(packet, 'C5', 'The implementation must preserve the evidenced local mechanism.')],
    options: [
      {
        claims: [fact(packet, 'C7', 'Option one directly preserves the evidenced mechanism.')],
        id: 'O1',
        title: 'Direct local implementation',
        tradeoffs: [inference(packet, 'C8', 'Direct implementation minimizes local divergence.')],
      },
      {
        claims: [inference(packet, 'C9', 'Option two wraps the mechanism behind a local boundary.')],
        id: 'O2',
        title: 'Boundary-wrapped implementation',
        tradeoffs: [fact(packet, 'C10', 'The wrapper must still preserve the evidenced constraint.')],
      },
    ],
    overlap: [inference(packet, 'C6', 'Both options overlap at the evidenced mechanism boundary.')],
    recommendation: [inference(packet, 'C11', 'Select O1 because it minimizes divergence from the evidence.')],
    risks: [inference(packet, 'C14', 'Changing the mechanism could invalidate the evidenced behavior.')],
    scope: {
      in: [fact(packet, 'C2', 'The evidenced local mechanism is in scope.')],
      out: [inference(packet, 'C3', 'Uncited external systems are outside the evidenced scope.')],
    },
    successCriteria: [
      {
        criterion: 'The selected option preserves the evidenced behavior.',
        id: 'SC1',
        verification: 'Compare implementation behavior with the cited evidence.',
      },
      {
        criterion: 'The final packet remains deterministically valid.',
        id: 'SC2',
        verification: 'Validate the final packet and require success.',
      },
    ],
    unresolvedQuestions: [unknown('C13', 'Could a non-blocking future constraint alter the trade-off?')],
  };
  return packet;
}

function finalPacket(repo) {
  const packet = discussionPacket(repo);
  packet.stage = 'final';
  packet.discussion.decisions[0] = {
    answer: 'Select O1.',
    id: 'D1',
    question: 'Which evidence-supported implementation option should be selected?',
    rationale: [fact(packet, 'C12', 'The evidence supports selecting O1.')],
    status: 'resolved',
  };
  packet.discussion.executablePlan = [
    {
      action: 'Implement O1 while preserving the evidenced mechanism.',
      claims: [inference(packet, 'C15', 'The first step follows the selected evidence-backed option.')],
      dependsOn: [],
      id: 'P1',
      successCriteria: ['SC1'],
      verification: 'Compare implementation behavior with the cited evidence.',
    },
    {
      action: 'Validate the completed evidence packet.',
      claims: [fact(packet, 'C16', 'The final verification uses the cited mechanism.')],
      dependsOn: ['P1'],
      id: 'P2',
      successCriteria: ['SC2'],
      verification: 'Validate the final packet and require success.',
    },
  ];
  return packet;
}

function clearSemanticCategory(packet, category) {
  if (category === 'scope.in' || category === 'scope.out') {
    const key = category.split('.')[1];
    packet.discussion.scope[key] = [];
  } else {
    packet.discussion[category] = [];
  }
}

function expectValidation(packet, pattern) {
  assert.throws(
    () => validatePacket(packet),
    (error) => error instanceof PacketValidationError && pattern.test(error.message),
  );
}

function directoryDigest(root) {
  const hash = createHash('sha256');
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      hash.update(relativePath);
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relativePath);
      else hash.update(readFileSync(absolute));
    }
  };
  walk(root);
  return hash.digest('hex');
}

test('valid flow accepts scaffold, discussion, and final packet stages', (t) => {
  const { repo } = fixture(t);
  const scaffold = collect(repo);
  assert.equal(scaffold.stage, 'scaffold');
  assert.equal(validatePacket(scaffold), scaffold);

  const discussion = discussionPacket(repo);
  assert.equal(discussion.discussion.executablePlan.length, 0);
  assert.equal(validatePacket(discussion), discussion);

  const final = finalPacket(repo);
  assert.equal(validatePacket(final), final);
  assert.deepEqual(
    Object.keys(final).sort(),
    ['discussion', 'goal', 'repository', 'schemaVersion', 'sources', 'stage'],
  );
});

test('validate rejects missing and unknown packet stages', (t) => {
  const { repo } = fixture(t);
  const missing = collect(repo);
  delete missing.stage;
  expectValidation(missing, /stage: must be scaffold, discussion, or final/);

  const unknownStage = collect(repo);
  unknownStage.stage = 'implementation';
  expectValidation(unknownStage, /stage: must be scaffold, discussion, or final/);
});

for (const stage of ['discussion', 'final']) {
  for (const category of [
    'goal',
    'constraints',
    'scope.in',
    'scope.out',
    'currentMechanisms',
    'localImplementation',
    'overlap',
    'options',
    'recommendation',
    'risks',
    'successCriteria',
  ]) {
    test(`${stage} rejects empty semantic category ${category}`, (t) => {
      const { repo } = fixture(t);
      const packet = stage === 'discussion' ? discussionPacket(repo) : finalPacket(repo);
      clearSemanticCategory(packet, category);
      assert.throws(() => validatePacket(packet), PacketValidationError);
    });
  }
}

for (const stage of ['discussion', 'final']) {
  test(`${stage} requires distinct substantive options`, (t) => {
    const { repo } = fixture(t);
    const createPacket = () => stage === 'discussion' ? discussionPacket(repo) : finalPacket(repo);

    const duplicateTitle = createPacket();
    duplicateTitle.discussion.options[1].title = '  DIRECT   LOCAL IMPLEMENTATION  ';
    expectValidation(duplicateTitle, /title: must be distinct after normalization/);

    const missingClaims = createPacket();
    missingClaims.discussion.options[0].claims = [];
    expectValidation(missingClaims, /options\[0\]\.claims: must contain at least one evidence-specific claim/);

    const missingTradeoffs = createPacket();
    missingTradeoffs.discussion.options[0].tradeoffs = [];
    expectValidation(missingTradeoffs, /options\[0\]\.tradeoffs: must contain at least one evidence-specific claim/);
  });
}

test('discussion requires exactly one unresolved decision', (t) => {
  const { repo } = fixture(t);
  const none = discussionPacket(repo);
  none.discussion.decisions[0] = {
    answer: 'Select O1.',
    id: 'D1',
    question: 'Which evidence-supported implementation option should be selected?',
    rationale: [fact(none, 'C12', 'The evidence supports selecting O1.')],
    status: 'resolved',
  };
  expectValidation(none, /requires exactly one unresolved decision/);

  const multiple = discussionPacket(repo);
  multiple.discussion.decisions.push({
    answer: null,
    id: 'D2',
    question: 'Should another blocking choice remain open?',
    rationale: [inference(multiple, 'C15', 'The evidence exposes another possible choice.')],
    status: 'unresolved',
  });
  expectValidation(multiple, /requires exactly one unresolved decision/);
});

test('discussion rejects an implementation plan while its decision is unresolved', (t) => {
  const { repo } = fixture(t);
  const packet = discussionPacket(repo);
  packet.discussion.executablePlan = structuredClone(finalPacket(repo).discussion.executablePlan);
  expectValidation(packet, /must be empty until the discussion decision is resolved/);
});

test('final rejects unresolved decisions and requires a nonempty plan', (t) => {
  const { repo } = fixture(t);
  const unresolved = finalPacket(repo);
  unresolved.discussion.decisions[0] = structuredClone(discussionPacket(repo).discussion.decisions[0]);
  expectValidation(unresolved, /final stage requires zero unresolved decisions/);

  const noPlan = finalPacket(repo);
  noPlan.discussion.executablePlan = [];
  expectValidation(noPlan, /final stage requires at least one plan step/);
});

test('discussion and final reject scaffold sentinels and Unknown-only recommendations, options, or plan claims', (t) => {
  const { repo } = fixture(t);
  const sentinel = discussionPacket(repo);
  sentinel.discussion.goal[0].statement = 'The requested discussion goal is: unchanged scaffold';
  expectValidation(sentinel, /contains scaffold sentinel content/);

  const unknownRecommendation = discussionPacket(repo);
  unknownRecommendation.discussion.recommendation = [unknown('C11', 'The recommendation is not known.')];
  expectValidation(unknownRecommendation, /cannot contain only Unknown claims/);

  const unknownOption = discussionPacket(repo);
  unknownOption.discussion.options[0].claims = [unknown('C7', 'The option evidence is unknown.')];
  unknownOption.discussion.options[0].tradeoffs = [];
  expectValidation(unknownOption, /cannot contain only Unknown claims/);

  const unknownPlan = finalPacket(repo);
  unknownPlan.discussion.executablePlan[0].claims = [unknown('C15', 'The plan basis is unknown.')];
  expectValidation(unknownPlan, /cannot contain only Unknown claims/);
});

test('collection is deterministic with stable source and Git ordering', (t) => {
  const { repo } = fixture(t);
  const args = [
    'collect',
    '--repo', repo,
    '--goal', 'Choose the safest local implementation.',
    '--evidence', 'mechanism=evidence.txt', 'architecture=architecture.txt',
  ];
  const first = run(args);
  const second = run(args);
  assert.equal(first.status, EXIT.OK, first.stderr);
  assert.equal(second.status, EXIT.OK, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const packet = JSON.parse(first.stdout);
  assert.deepEqual(packet.sources.map(({ id, role, path }) => ({ id, role, path })), [
    { id: 'S1', path: 'architecture.txt', role: 'architecture' },
    { id: 'S2', path: 'evidence.txt', role: 'mechanism' },
  ]);
  const statusKeys = packet.repository.git.status.map(
    ({ code, path, originalPath }) => `${code}\0${path}\0${originalPath ?? ''}`,
  );
  assert.deepEqual(statusKeys, [...statusKeys].sort());
});

test('collection handles Git rename records deterministically', (t) => {
  const { repo } = fixture(t);
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'driver-test@example.invalid']);
  git(repo, ['config', 'user.name', 'Driver Test']);
  git(repo, ['add', 'evidence.txt', 'architecture.txt']);
  git(repo, ['commit', '--quiet', '-m', 'baseline']);
  git(repo, ['mv', 'evidence.txt', 'renamed.txt']);

  const result = run([
    'collect', '--repo', repo,
    '--goal', 'Choose the safest local implementation.',
    '--evidence', 'mechanism=renamed.txt',
  ]);
  assert.equal(result.status, EXIT.OK, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.deepEqual(packet.repository.git.status, [
    { code: 'R ', originalPath: 'evidence.txt', path: 'renamed.txt' },
  ]);
});

test('validate accepts supported porcelain-v1 ordinary and special statuses', (t) => {
  const { repo } = fixture(t);
  const packet = collect(repo);
  packet.repository.git.status = [
    { code: ' M', originalPath: null, path: 'modified.txt' },
    { code: '!!', originalPath: null, path: 'ignored/cache.bin' },
    { code: '??', originalPath: null, path: 'untracked.txt' },
    { code: 'C ', originalPath: 'source.txt', path: 'copied.txt' },
    { code: 'R ', originalPath: 'before.txt', path: 'after.txt' },
  ];
  assert.equal(validatePacket(packet), packet);
});

test('validate rejects invalid Git status codes and repository paths', (t) => {
  const { repo } = fixture(t);

  const invalidCode = collect(repo);
  invalidCode.repository.git.status = [{ code: 'ZZ', originalPath: null, path: 'file.txt' }];
  expectValidation(invalidCode, /must be a valid porcelain-v1 XY status/);

  const invalidPath = collect(repo);
  invalidPath.repository.git.status = [{ code: '??', originalPath: null, path: '../escape' }];
  expectValidation(invalidPath, /path: must be a normalized repository-relative POSIX path/);

  const invalidOriginalPath = collect(repo);
  invalidOriginalPath.repository.git.status = [{ code: 'R ', originalPath: './before.txt', path: 'after.txt' }];
  expectValidation(invalidOriginalPath, /originalPath: must be a normalized repository-relative POSIX path/);
});

test('collect supports canonical stdout and atomic --out outside the target repository', (t) => {
  const { repo, root } = fixture(t);
  const base = [
    'collect', '--repo', repo,
    '--goal', 'Choose the safest local implementation.',
    '--evidence', 'mechanism=evidence.txt',
  ];
  const stdoutResult = run(base);
  assert.equal(stdoutResult.status, EXIT.OK, stdoutResult.stderr);
  assert.match(stdoutResult.stdout, /\n$/);

  const out = resolve(root, 'packet.json');
  const outResult = run([...base, '--out', out]);
  assert.equal(outResult.status, EXIT.OK, outResult.stderr);
  assert.equal(outResult.stdout, '');
  assert.equal(readFileSync(out, 'utf8'), stdoutResult.stdout);
  assert.equal(readdirSync(root).some((name) => name.includes('.tmp-')), false);

  const unsafe = run([...base, '--out', resolve(repo, 'packet.json')]);
  assert.equal(unsafe.status, EXIT.SAFETY);
  assert.match(unsafe.stderr, /safety-error: output path must be outside/);
  assert.equal(existsSync(resolve(repo, 'packet.json')), false);

  const unsafeMissingParent = run([...base, '--out', resolve(repo, 'missing', 'packet.json')]);
  assert.equal(unsafeMissingParent.status, EXIT.SAFETY);
  assert.equal(existsSync(resolve(repo, 'missing')), false);
});

test('atomic output preserves a pre-existing temp-path collision', (t) => {
  const { repo, root } = fixture(t);
  const output = resolve(root, 'packet.json');
  const collision = resolve(root, `.packet.json.tmp-${process.pid}`);
  writeFileSync(collision, 'unrelated sentinel', 'utf8');

  assert.throws(() => writePacketAtomic(output, repo, collect(repo)), /could not atomically write output/);
  assert.equal(readFileSync(collision, 'utf8'), 'unrelated sentinel');
  assert.equal(existsSync(output), false);
});

test('collect rejects malformed and duplicate evidence roles', (t) => {
  const { repo } = fixture(t);
  const base = ['collect', '--repo', repo, '--goal', 'Discuss design.', '--evidence'];
  const malformed = run([...base, 'Bad_Role=evidence.txt']);
  assert.equal(malformed.status, EXIT.INPUT);
  assert.match(malformed.stderr, /invalid evidence role/);

  const duplicate = run([...base, 'mechanism=evidence.txt', 'mechanism=architecture.txt']);
  assert.equal(duplicate.status, EXIT.INPUT);
  assert.match(duplicate.stderr, /duplicate evidence role/);
});

test('validate rejects invalid JSON, wrong packets, and missing discussion categories', (t) => {
  const { repo, root } = fixture(t);
  const invalidJson = resolve(root, 'invalid.json');
  writeFileSync(invalidJson, '{', 'utf8');
  const invalidResult = run(['validate', '--packet', invalidJson]);
  assert.equal(invalidResult.status, EXIT.INPUT);
  assert.match(invalidResult.stderr, /packet is not valid JSON/);

  const wrong = collect(repo);
  wrong.schemaVersion = '0';
  const wrongResult = run(['validate', '--packet', packetFile(root, wrong, 'wrong.json')]);
  assert.equal(wrongResult.status, EXIT.VALIDATION);
  assert.match(wrongResult.stderr, /schemaVersion/);

  const missing = collect(repo);
  delete missing.discussion.overlap;
  const missingResult = run(['validate', '--packet', packetFile(root, missing, 'missing.json')]);
  assert.equal(missingResult.status, EXIT.VALIDATION);
  assert.match(missingResult.stderr, /missing required category overlap/);
});

test('validate rejects non-normalized packet paths', (t) => {
  const { repo } = fixture(t);
  const packet = collect(repo);
  packet.sources[0].path = './evidence.txt';
  expectValidation(packet, /must be a normalized repository-relative path/);
});

test('validate rejects stale source hashes and stale source metadata', (t) => {
  const { evidencePath, repo } = fixture(t);
  const packet = collect(repo);
  writeFileSync(evidencePath, 'mechanism changed\nconstraint two\nverification three\n', 'utf8');
  expectValidation(packet, /sources\[0\]\.(?:byteLength|sha256): is stale/);
});

test('validate rejects out-of-range and stale citation excerpt hashes', (t) => {
  const { repo } = fixture(t);
  const outOfRange = collect(repo);
  outOfRange.discussion.currentMechanisms[0].citations[0].endLine = 99;
  expectValidation(outOfRange, /line range 1-99 exceeds source line count/);

  const badHash = collect(repo);
  badHash.discussion.currentMechanisms[0].citations[0].excerptHash = '0'.repeat(64);
  expectValidation(badHash, /does not match the cited excerpt/);
});

test('claim validation enforces classifications and citation rules', (t) => {
  const { repo } = fixture(t);
  for (const classification of ['Fact', 'Inference']) {
    const packet = collect(repo);
    packet.discussion.currentMechanisms[0].classification = classification;
    packet.discussion.currentMechanisms[0].citations = [];
    expectValidation(packet, new RegExp(`${classification} claims require at least one citation`));
  }

  const unknown = collect(repo);
  unknown.discussion.currentMechanisms[0].classification = 'Unknown';
  expectValidation(unknown, /Unknown claims must not contain citations/);

  const invalid = collect(repo);
  invalid.discussion.currentMechanisms[0].classification = 'Opinion';
  expectValidation(invalid, /must be Fact, Inference, or Unknown/);
});

test('decision validation rejects missing answers and Unknown rationales on resolved decisions', (t) => {
  const { repo } = fixture(t);
  const missingAnswer = collect(repo);
  missingAnswer.discussion.decisions[0].status = 'resolved';
  expectValidation(missingAnswer, /discussion\.decisions\[0\]\.answer: must be a non-empty string/);

  const unknownRationale = collect(repo);
  unknownRationale.discussion.decisions[0].status = 'resolved';
  unknownRationale.discussion.decisions[0].answer = 'Proceed.';
  expectValidation(unknownRationale, /resolved decisions cannot rely on Unknown claims/);

  const prematureAnswer = collect(repo);
  prematureAnswer.discussion.decisions[0].answer = 'Proceed.';
  expectValidation(prematureAnswer, /must be null while the decision is unresolved/);
});

test('plan validation rejects missing dependencies and dependency cycles', (t) => {
  const { repo } = fixture(t);
  const missing = collect(repo);
  missing.discussion.executablePlan[0].dependsOn = ['P2'];
  expectValidation(missing, /missing dependency P2/);

  const cycle = collect(repo);
  cycle.discussion.executablePlan.push({
    action: 'Verify the first step.',
    claims: [],
    dependsOn: ['P1'],
    id: 'P2',
    successCriteria: ['SC1'],
    verification: 'Run deterministic validation.',
  });
  cycle.discussion.executablePlan[0].dependsOn = ['P2'];
  expectValidation(cycle, /dependency cycle includes/);
});

test('plan and success criteria require verification and criterion references', (t) => {
  const { repo } = fixture(t);
  const missingStepVerification = collect(repo);
  delete missingStepVerification.discussion.executablePlan[0].verification;
  expectValidation(missingStepVerification, /executablePlan\[0\]\.verification/);

  const missingReferences = collect(repo);
  missingReferences.discussion.executablePlan[0].successCriteria = [];
  expectValidation(missingReferences, /must reference at least one criterion/);

  const missingCriterionVerification = collect(repo);
  delete missingCriterionVerification.discussion.successCriteria[0].verification;
  expectValidation(missingCriterionVerification, /successCriteria\[0\]\.verification/);
});

test('validate CLI accepts a complete packet and emits canonical success JSON', (t) => {
  const { repo, root } = fixture(t);
  const result = run(['validate', '--packet', packetFile(root, finalPacket(repo))]);
  assert.equal(result.status, EXIT.OK, result.stderr);
  assert.equal(result.stdout, canonicalJson({ ok: true, stage: 'final' }));
  assert.equal(result.stderr, '');
});

test('smoke cleans its isolated fixture and does not mutate the target', (t) => {
  const { repo } = fixture(t);
  git(repo, ['init', '--quiet']);
  git(repo, ['add', 'evidence.txt', 'architecture.txt']);
  const beforeDigest = directoryDigest(repo);
  const beforeSmokeDirectories = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(SMOKE_PREFIX)));
  const result = runSmoke(repo);
  const afterSmokeDirectories = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(SMOKE_PREFIX)));

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    deterministicCollection: true,
    discussionValidation: true,
    finalValidation: true,
    fixtureCleanup: true,
    scaffoldValidation: true,
    staleEvidenceRejection: true,
    targetNonMutation: true,
  });
  assert.equal(directoryDigest(repo), beforeDigest);
  assert.deepEqual(afterSmokeDirectories, beforeSmokeDirectories);
});

test('smoke CLI succeeds and documents stable nonzero exit classes', (t) => {
  const { repo } = fixture(t);
  const smoke = run(['smoke', '--repo', repo]);
  assert.equal(smoke.status, EXIT.OK, smoke.stderr);
  assert.equal(JSON.parse(smoke.stdout).ok, true);

  const help = run(['--help']);
  assert.equal(help.status, EXIT.OK);
  for (const [code, label] of [
    [2, 'usage error'],
    [3, 'bounded input or parse error'],
    [4, 'packet validation error'],
    [5, 'filesystem or process I/O error'],
    [6, 'repository safety violation'],
    [7, 'smoke verification failure'],
  ]) assert.match(help.stdout, new RegExp(`  ${code} ${label}`));
});
