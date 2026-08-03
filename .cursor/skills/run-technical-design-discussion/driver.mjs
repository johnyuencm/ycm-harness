#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  INPUT: 3,
  VALIDATION: 4,
  IO: 5,
  SAFETY: 6,
  SMOKE: 7,
});

export const LIMITS = Object.freeze({
  goalBytes: 16 * 1024,
  sourceCount: 32,
  sourceBytes: 1024 * 1024,
  totalSourceBytes: 4 * 1024 * 1024,
  packetBytes: 8 * 1024 * 1024,
  gitBytes: 1024 * 1024,
});

export const SCHEMA_VERSION = '2.0.0';
export const SMOKE_PREFIX = 'run-technical-design-discussion-';

const PACKET_STAGES = new Set(['scaffold', 'discussion', 'final']);
const SCAFFOLD_SENTINEL_STRINGS = new Set([
  'The recommendation remains unresolved until the evidence is analyzed.',
  'Enrich this packet with evidence-grounded findings before implementation work begins.',
  'Concrete implementation steps depend on the unresolved design decision.',
  'Run validate --packet on the enriched packet and require exit code 0.',
  'No implementation option has been recommended yet.',
  'In-scope mechanisms must be derived from the collected evidence.',
  'Out-of-scope work must be stated before implementation.',
  'The enriched discussion packet satisfies every deterministic validation rule.',
  'Run validate --packet and require exit code 0.',
  'What evidence-backed constraints and trade-offs determine the recommendation?',
]);

const REQUIRED_DISCUSSION_CATEGORIES = Object.freeze([
  'goal',
  'scope',
  'constraints',
  'currentMechanisms',
  'localImplementation',
  'overlap',
  'options',
  'recommendation',
  'decisions',
  'unresolvedQuestions',
  'risks',
  'successCriteria',
  'executablePlan',
]);
const CLAIM_CATEGORIES = Object.freeze([
  'goal',
  'constraints',
  'currentMechanisms',
  'localImplementation',
  'overlap',
  'recommendation',
  'unresolvedQuestions',
  'risks',
]);
const CLASSIFICATIONS = new Set(['Fact', 'Inference', 'Unknown']);
const ROLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PORCELAIN_STATUS_CODES = new Set([
  ' M', ' T', ' D', ' R', ' C',
  'M ', 'MM', 'MT', 'MD',
  'T ', 'TM', 'TT', 'TD',
  'A ', 'AM', 'AT', 'AD',
  'D ',
  'R ', 'RM', 'RT', 'RD',
  'C ', 'CM', 'CT', 'CD',
  'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU',
  '??', '!!',
]);
const ID_PATTERNS = Object.freeze({
  claim: /^C[1-9][0-9]*$/,
  option: /^O[1-9][0-9]*$/,
  decision: /^D[1-9][0-9]*$/,
  criterion: /^SC[1-9][0-9]*$/,
  step: /^P[1-9][0-9]*$/,
  source: /^S[1-9][0-9]*$/,
});

class DriverError extends Error {
  constructor(message, exitCode, label) {
    super(message);
    this.exitCode = exitCode;
    this.label = label;
  }
}

export class UsageError extends DriverError {
  constructor(message) {
    super(message, EXIT.USAGE, 'usage-error');
  }
}

export class InputError extends DriverError {
  constructor(message) {
    super(message, EXIT.INPUT, 'input-error');
  }
}

export class PacketValidationError extends DriverError {
  constructor(message) {
    super(message, EXIT.VALIDATION, 'validation-error');
  }
}

export class IoError extends DriverError {
  constructor(message) {
    super(message, EXIT.IO, 'io-error');
  }
}

export class SafetyError extends DriverError {
  constructor(message) {
    super(message, EXIT.SAFETY, 'safety-error');
  }
}

export class SmokeError extends DriverError {
  constructor(message) {
    super(message, EXIT.SMOKE, 'smoke-error');
  }
}

function failValidation(path, message) {
  throw new PacketValidationError(`${path}: ${message}`);
}

function normalizePath(value) {
  return value.split(sep).join('/');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareGitStatus(left, right) {
  return compareText(left.code, right.code)
    || compareText(left.path, right.path)
    || compareText(left.originalPath ?? '', right.originalPath ?? '');
}

function isNormalizedRepositoryPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes('\0')
    && !posix.isAbsolute(value)
    && !/^[A-Za-z]:\//.test(value)
    && value !== '.'
    && value === posix.normalize(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new InputError(`${label} is not valid UTF-8`);
  }
}

function sourceLines(text) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function excerptHash(lines, startLine, endLine) {
  return sha256(lines.slice(startLine - 1, endLine).join('\n'));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function boundedExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: LIMITS.gitBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
  } catch (error) {
    if (error?.status !== undefined) return null;
    throw new IoError(`could not execute ${command}: ${error.message}`);
  }
}

function parseGitStatus(rawStatus) {
  const fields = rawStatus.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const status = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4 || field[2] !== ' ') throw new IoError('Git returned malformed porcelain status');
    const code = field.slice(0, 2);
    if (!PORCELAIN_STATUS_CODES.has(code)) throw new IoError(`Git returned invalid porcelain status ${JSON.stringify(code)}`);
    const path = normalizePath(field.slice(3));
    if (!isNormalizedRepositoryPath(path)) throw new IoError('Git returned a non-normalized repository path');
    let originalPath = null;
    if (code.includes('R') || code.includes('C')) {
      const original = fields[++index];
      if (original === undefined) throw new IoError('Git returned an incomplete rename or copy status');
      originalPath = normalizePath(original);
      if (!isNormalizedRepositoryPath(originalPath)) {
        throw new IoError('Git returned a non-normalized original repository path');
      }
    }
    status.push({ code, originalPath, path });
  }
  return status.sort(compareGitStatus);
}

function getGitInfo(repoRoot) {
  const inside = boundedExec('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return { branch: null, head: null, status: [] };

  const branch = boundedExec('git', ['-C', repoRoot, 'branch', '--show-current'])?.trim() || null;
  const head = boundedExec('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])?.trim() || null;
  const rawStatus = boundedExec('git', [
    '-C',
    repoRoot,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (rawStatus === null) throw new IoError('could not read repository Git status');
  return { branch, head, status: parseGitStatus(rawStatus) };
}

function resolveDirectory(input, label) {
  const absolute = resolve(input);
  let real;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    throw new InputError(`${label} does not exist: ${absolute} (${error.code ?? 'error'})`);
  }
  if (!statSync(real).isDirectory()) throw new InputError(`${label} is not a directory: ${absolute}`);
  return real;
}

function readBoundedFile(path, maxBytes, label, ErrorType = InputError) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw new ErrorType(`${label} cannot be read: ${path} (${error.code ?? 'error'})`);
  }
  if (!stats.isFile()) throw new ErrorType(`${label} is not a regular file: ${path}`);
  if (stats.size > maxBytes) {
    throw new ErrorType(`${label} exceeds ${maxBytes} bytes: ${path}`);
  }
  try {
    return readFileSync(path);
  } catch (error) {
    throw new ErrorType(`${label} cannot be read: ${path} (${error.code ?? 'error'})`);
  }
}

function parseEvidenceSpec(spec) {
  const separator = spec.indexOf('=');
  if (separator <= 0 || separator === spec.length - 1) {
    throw new UsageError(`invalid --evidence value ${JSON.stringify(spec)}; expected role=path`);
  }
  const role = spec.slice(0, separator);
  const path = spec.slice(separator + 1);
  if (!ROLE_PATTERN.test(role)) {
    throw new InputError(`invalid evidence role ${JSON.stringify(role)}; use lowercase kebab-case`);
  }
  return { role, path };
}

function loadSources(repoRoot, evidenceSpecs) {
  if (evidenceSpecs.length === 0) throw new UsageError('collect requires at least one --evidence role=path');
  if (evidenceSpecs.length > LIMITS.sourceCount) {
    throw new InputError(`too many evidence sources; maximum is ${LIMITS.sourceCount}`);
  }

  const resolved = evidenceSpecs.map(parseEvidenceSpec).map(({ role, path }) => {
    const candidate = resolve(repoRoot, path);
    let real;
    try {
      real = realpathSync(candidate);
    } catch (error) {
      throw new InputError(`evidence path does not exist: ${path} (${error.code ?? 'error'})`);
    }
    if (!isWithin(repoRoot, real)) throw new SafetyError(`evidence path escapes target repository: ${path}`);
    const repoPath = normalizePath(relative(repoRoot, real));
    if (!repoPath || repoPath.startsWith('../')) {
      throw new SafetyError(`invalid evidence path inside repository: ${path}`);
    }
    return { role, real, path: repoPath };
  }).sort((a, b) => compareText(a.role, b.role) || compareText(a.path, b.path));

  const seenRoles = new Set();
  const seenPaths = new Set();
  let totalBytes = 0;
  return resolved.map((item, index) => {
    if (seenRoles.has(item.role)) throw new InputError(`duplicate evidence role: ${item.role}`);
    if (seenPaths.has(item.path)) throw new InputError(`duplicate evidence path: ${item.path}`);
    seenRoles.add(item.role);
    seenPaths.add(item.path);

    const buffer = readBoundedFile(item.real, LIMITS.sourceBytes, 'evidence source');
    totalBytes += buffer.byteLength;
    if (totalBytes > LIMITS.totalSourceBytes) {
      throw new InputError(`total evidence exceeds ${LIMITS.totalSourceBytes} bytes`);
    }
    const text = decodeUtf8(buffer, `evidence source ${item.path}`);
    const lines = sourceLines(text);
    if (lines.length === 0) throw new InputError(`evidence source is empty: ${item.path}`);
    return {
      byteLength: buffer.byteLength,
      id: `S${index + 1}`,
      lineCount: lines.length,
      path: item.path,
      role: item.role,
      sha256: sha256(buffer),
    };
  });
}

function citationFor(source, repoRoot) {
  const buffer = readBoundedFile(resolve(repoRoot, source.path), LIMITS.sourceBytes, 'evidence source');
  const lines = sourceLines(decodeUtf8(buffer, `evidence source ${source.path}`));
  return {
    endLine: 1,
    excerptHash: excerptHash(lines, 1, 1),
    sourceId: source.id,
    startLine: 1,
  };
}

function scaffoldDiscussion(goal, sources, repoRoot) {
  let claimNumber = 0;
  const claim = (classification, statement, citations = []) => ({
    citations,
    classification,
    id: `C${++claimNumber}`,
    statement,
  });
  const unknown = (statement) => claim('Unknown', statement);
  const sourceClaim = claim(
    'Fact',
    `Evidence source ${sources[0].id} was collected for grounded discussion.`,
    [citationFor(sources[0], repoRoot)],
  );

  return {
    constraints: [],
    currentMechanisms: [sourceClaim],
    decisions: [
      {
        answer: null,
        id: 'D1',
        question: 'Which evidence-supported implementation option should be selected?',
        rationale: [unknown('The recommendation remains unresolved until the evidence is analyzed.')],
        status: 'unresolved',
      },
    ],
    executablePlan: [
      {
        action: 'Enrich this packet with evidence-grounded findings before implementation work begins.',
        claims: [unknown('Concrete implementation steps depend on the unresolved design decision.')],
        dependsOn: [],
        id: 'P1',
        successCriteria: ['SC1'],
        verification: 'Run validate --packet on the enriched packet and require exit code 0.',
      },
    ],
    goal: [unknown(`The requested discussion goal is: ${goal}`)],
    localImplementation: [],
    options: [],
    overlap: [],
    recommendation: [unknown('No implementation option has been recommended yet.')],
    risks: [],
    scope: {
      in: [unknown('In-scope mechanisms must be derived from the collected evidence.')],
      out: [unknown('Out-of-scope work must be stated before implementation.')],
    },
    successCriteria: [
      {
        criterion: 'The enriched discussion packet satisfies every deterministic validation rule.',
        id: 'SC1',
        verification: 'Run validate --packet and require exit code 0.',
      },
    ],
    unresolvedQuestions: [unknown('What evidence-backed constraints and trade-offs determine the recommendation?')],
  };
}

export function collectPacket({ repo, goal, evidence }) {
  if (typeof goal !== 'string' || goal.trim() === '') throw new InputError('goal must be a non-empty string');
  if (Buffer.byteLength(goal, 'utf8') > LIMITS.goalBytes) {
    throw new InputError(`goal exceeds ${LIMITS.goalBytes} bytes`);
  }
  const repoRoot = resolveDirectory(repo, 'repository');
  const sources = loadSources(repoRoot, evidence);
  return {
    discussion: scaffoldDiscussion(goal, sources, repoRoot),
    goal,
    repository: {
      git: getGitInfo(repoRoot),
      root: normalizePath(repoRoot),
    },
    schemaVersion: SCHEMA_VERSION,
    sources,
    stage: 'scaffold',
  };
}

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failValidation(path, 'must be an object');
  return value;
}

function requireArray(value, path) {
  if (!Array.isArray(value)) failValidation(path, 'must be an array');
  return value;
}

function requireString(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || value.trim() === '') failValidation(path, 'must be a non-empty string');
  return value;
}

function requireId(value, path, pattern) {
  requireString(value, path);
  if (!pattern.test(value)) failValidation(path, 'has an invalid identifier');
  return value;
}

function assertUnique(id, set, path) {
  if (set.has(id)) failValidation(path, `duplicates identifier ${id}`);
  set.add(id);
}

function validateCitation(citation, path, sourceMap, sourceData) {
  requireObject(citation, path);
  requireString(citation.sourceId, `${path}.sourceId`);
  const source = sourceMap.get(citation.sourceId);
  if (!source) failValidation(`${path}.sourceId`, `references missing source ${citation.sourceId}`);
  if (!Number.isInteger(citation.startLine) || citation.startLine < 1) {
    failValidation(`${path}.startLine`, 'must be a positive integer');
  }
  if (!Number.isInteger(citation.endLine) || citation.endLine < citation.startLine) {
    failValidation(`${path}.endLine`, 'must be an integer at or after startLine');
  }
  const lines = sourceData.get(source.id).lines;
  if (citation.endLine > lines.length) {
    failValidation(path, `line range ${citation.startLine}-${citation.endLine} exceeds source line count ${lines.length}`);
  }
  if (typeof citation.excerptHash !== 'string' || !HASH_PATTERN.test(citation.excerptHash)) {
    failValidation(`${path}.excerptHash`, 'must be a lowercase SHA-256 hash');
  }
  const actual = excerptHash(lines, citation.startLine, citation.endLine);
  if (citation.excerptHash !== actual) failValidation(`${path}.excerptHash`, 'does not match the cited excerpt');
}

function validateClaim(value, path, context) {
  const claim = requireObject(value, path);
  requireId(claim.id, `${path}.id`, ID_PATTERNS.claim);
  assertUnique(claim.id, context.claimIds, `${path}.id`);
  if (!CLASSIFICATIONS.has(claim.classification)) {
    failValidation(`${path}.classification`, 'must be Fact, Inference, or Unknown');
  }
  requireString(claim.statement, `${path}.statement`);
  const citations = requireArray(claim.citations, `${path}.citations`);
  if ((claim.classification === 'Fact' || claim.classification === 'Inference') && citations.length === 0) {
    failValidation(`${path}.citations`, `${claim.classification} claims require at least one citation`);
  }
  if (claim.classification === 'Unknown' && citations.length !== 0) {
    failValidation(`${path}.citations`, 'Unknown claims must not contain citations');
  }
  citations.forEach((citation, index) => {
    validateCitation(citation, `${path}.citations[${index}]`, context.sourceMap, context.sourceData);
  });
  return claim;
}

function validateClaimArray(value, path, context) {
  requireArray(value, path).forEach((claim, index) => validateClaim(claim, `${path}[${index}]`, context));
}

function validateSources(packet, repoRoot) {
  const sources = requireArray(packet.sources, 'sources');
  if (sources.length === 0) failValidation('sources', 'must contain at least one source');
  if (sources.length > LIMITS.sourceCount) failValidation('sources', `exceeds maximum count ${LIMITS.sourceCount}`);
  const sourceMap = new Map();
  const sourceData = new Map();
  const ordering = [];
  let totalBytes = 0;

  sources.forEach((value, index) => {
    const path = `sources[${index}]`;
    const source = requireObject(value, path);
    requireId(source.id, `${path}.id`, ID_PATTERNS.source);
    if (source.id !== `S${index + 1}`) failValidation(`${path}.id`, `must be S${index + 1} in stable source order`);
    if (sourceMap.has(source.id)) failValidation(`${path}.id`, `duplicates ${source.id}`);
    requireString(source.role, `${path}.role`);
    if (!ROLE_PATTERN.test(source.role)) failValidation(`${path}.role`, 'must use lowercase kebab-case');
    requireString(source.path, `${path}.path`);
    if (!isNormalizedRepositoryPath(source.path)) {
      failValidation(`${path}.path`, 'must be a normalized repository-relative path');
    }
    if (typeof source.sha256 !== 'string' || !HASH_PATTERN.test(source.sha256)) {
      failValidation(`${path}.sha256`, 'must be a lowercase SHA-256 hash');
    }
    if (!Number.isInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > LIMITS.sourceBytes) {
      failValidation(`${path}.byteLength`, `must be between 1 and ${LIMITS.sourceBytes}`);
    }
    if (!Number.isInteger(source.lineCount) || source.lineCount < 1) {
      failValidation(`${path}.lineCount`, 'must be a positive integer');
    }
    ordering.push(`${source.role}\0${source.path}`);
    if (index > 0 && compareText(ordering[index - 1], ordering[index]) >= 0) {
      failValidation(path, 'sources must be uniquely sorted by role then path');
    }

    const absolute = resolve(repoRoot, ...source.path.split('/'));
    let real;
    try {
      real = realpathSync(absolute);
    } catch (error) {
      failValidation(`${path}.path`, `source is unavailable (${error.code ?? 'error'})`);
    }
    if (!isWithin(repoRoot, real)) failValidation(`${path}.path`, 'source escapes repository');
    const buffer = readBoundedFile(real, LIMITS.sourceBytes, 'source', PacketValidationError);
    totalBytes += buffer.byteLength;
    if (totalBytes > LIMITS.totalSourceBytes) failValidation('sources', 'total source size exceeds limit');
    const text = (() => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        failValidation(`${path}.path`, 'source is not valid UTF-8');
      }
    })();
    const lines = sourceLines(text);
    if (buffer.byteLength !== source.byteLength) failValidation(`${path}.byteLength`, 'is stale');
    if (sha256(buffer) !== source.sha256) failValidation(`${path}.sha256`, 'is stale');
    if (lines.length !== source.lineCount) failValidation(`${path}.lineCount`, 'is stale');
    sourceMap.set(source.id, source);
    sourceData.set(source.id, { lines });
  });
  return { sourceData, sourceMap };
}

function validateOptions(options, context) {
  const optionIds = new Set();
  requireArray(options, 'discussion.options').forEach((value, index) => {
    const path = `discussion.options[${index}]`;
    const option = requireObject(value, path);
    requireId(option.id, `${path}.id`, ID_PATTERNS.option);
    assertUnique(option.id, optionIds, `${path}.id`);
    requireString(option.title, `${path}.title`);
    validateClaimArray(option.claims, `${path}.claims`, context);
    validateClaimArray(option.tradeoffs, `${path}.tradeoffs`, context);
  });
}

function validateDecisions(decisions, context) {
  const decisionIds = new Set();
  requireArray(decisions, 'discussion.decisions').forEach((value, index) => {
    const path = `discussion.decisions[${index}]`;
    const decision = requireObject(value, path);
    requireId(decision.id, `${path}.id`, ID_PATTERNS.decision);
    assertUnique(decision.id, decisionIds, `${path}.id`);
    requireString(decision.question, `${path}.question`);
    if (decision.status !== 'resolved' && decision.status !== 'unresolved') {
      failValidation(`${path}.status`, 'must be resolved or unresolved');
    }
    const rationale = requireArray(decision.rationale, `${path}.rationale`);
    if (rationale.length === 0) failValidation(`${path}.rationale`, 'must contain at least one claim');
    const validated = rationale.map((claim, claimIndex) =>
      validateClaim(claim, `${path}.rationale[${claimIndex}]`, context));
    if (decision.status === 'resolved') {
      requireString(decision.answer, `${path}.answer`);
      if (validated.some((claim) => claim.classification === 'Unknown')) {
        failValidation(`${path}.rationale`, 'resolved decisions cannot rely on Unknown claims');
      }
    } else if (decision.answer !== null) {
      failValidation(`${path}.answer`, 'must be null while the decision is unresolved');
    }
  });
}

function validateSuccessCriteria(criteria) {
  const criterionIds = new Set();
  const values = requireArray(criteria, 'discussion.successCriteria');
  if (values.length === 0) failValidation('discussion.successCriteria', 'must contain at least one criterion');
  values.forEach((value, index) => {
    const path = `discussion.successCriteria[${index}]`;
    const criterion = requireObject(value, path);
    requireId(criterion.id, `${path}.id`, ID_PATTERNS.criterion);
    assertUnique(criterion.id, criterionIds, `${path}.id`);
    requireString(criterion.criterion, `${path}.criterion`);
    requireString(criterion.verification, `${path}.verification`);
  });
  return criterionIds;
}

function validatePlan(plan, criterionIds, context) {
  const values = requireArray(plan, 'discussion.executablePlan');
  const stepIds = new Set();
  const dependencies = new Map();
  values.forEach((value, index) => {
    const path = `discussion.executablePlan[${index}]`;
    const step = requireObject(value, path);
    requireId(step.id, `${path}.id`, ID_PATTERNS.step);
    assertUnique(step.id, stepIds, `${path}.id`);
    requireString(step.action, `${path}.action`);
    requireString(step.verification, `${path}.verification`);
    const dependsOn = requireArray(step.dependsOn, `${path}.dependsOn`);
    if (new Set(dependsOn).size !== dependsOn.length) failValidation(`${path}.dependsOn`, 'contains duplicates');
    dependsOn.forEach((dependency, dependencyIndex) => {
      requireId(dependency, `${path}.dependsOn[${dependencyIndex}]`, ID_PATTERNS.step);
      if (dependency === step.id) failValidation(`${path}.dependsOn`, 'cannot depend on itself');
    });
    dependencies.set(step.id, dependsOn);
    const successCriteria = requireArray(step.successCriteria, `${path}.successCriteria`);
    if (successCriteria.length === 0) failValidation(`${path}.successCriteria`, 'must reference at least one criterion');
    if (new Set(successCriteria).size !== successCriteria.length) {
      failValidation(`${path}.successCriteria`, 'contains duplicates');
    }
    successCriteria.forEach((criterionId, criterionIndex) => {
      requireId(criterionId, `${path}.successCriteria[${criterionIndex}]`, ID_PATTERNS.criterion);
      if (!criterionIds.has(criterionId)) {
        failValidation(`${path}.successCriteria[${criterionIndex}]`, `references missing criterion ${criterionId}`);
      }
    });
    validateClaimArray(step.claims, `${path}.claims`, context);
  });

  for (const [stepId, stepDependencies] of dependencies) {
    for (const dependency of stepDependencies) {
      if (!stepIds.has(dependency)) failValidation(`discussion.executablePlan.${stepId}`, `missing dependency ${dependency}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (stepId) => {
    if (visiting.has(stepId)) failValidation('discussion.executablePlan', `dependency cycle includes ${stepId}`);
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of dependencies.get(stepId)) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const stepId of stepIds) visit(stepId);
  return values;
}

function hasEvidenceClaim(claims) {
  return claims.some((claim) => claim.classification === 'Fact' || claim.classification === 'Inference');
}

function requireEvidenceSpecificClaims(claims, path) {
  if (claims.length === 0) failValidation(path, 'must contain at least one evidence-specific claim');
  if (!hasEvidenceClaim(claims)) failValidation(path, 'cannot contain only Unknown claims');
}

function isScaffoldSentinel(value) {
  return SCAFFOLD_SENTINEL_STRINGS.has(value)
    || value.startsWith('The requested discussion goal is: ')
    || /^Evidence source S[1-9][0-9]* was collected for grounded discussion\.$/.test(value);
}

function rejectScaffoldSentinels(value, path = 'discussion') {
  if (typeof value === 'string') {
    if (isScaffoldSentinel(value)) failValidation(path, 'contains scaffold sentinel content');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectScaffoldSentinels(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) rejectScaffoldSentinels(item, `${path}.${key}`);
  }
}

function validateCompleteAnalysis(discussion) {
  rejectScaffoldSentinels(discussion);
  for (const category of [
    'goal',
    'constraints',
    'currentMechanisms',
    'localImplementation',
    'overlap',
    'recommendation',
    'risks',
  ]) {
    requireEvidenceSpecificClaims(discussion[category], `discussion.${category}`);
  }
  requireEvidenceSpecificClaims(discussion.scope.in, 'discussion.scope.in');
  requireEvidenceSpecificClaims(discussion.scope.out, 'discussion.scope.out');
  if (discussion.options.length < 2) failValidation('discussion.options', 'must contain at least two options');
  const optionTitles = new Set();
  discussion.options.forEach((option, index) => {
    const path = `discussion.options[${index}]`;
    const normalizedTitle = option.title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
    if (optionTitles.has(normalizedTitle)) failValidation(`${path}.title`, 'must be distinct after normalization');
    optionTitles.add(normalizedTitle);
    requireEvidenceSpecificClaims(option.claims, `${path}.claims`);
    requireEvidenceSpecificClaims(option.tradeoffs, `${path}.tradeoffs`);
  });
  discussion.unresolvedQuestions.forEach((claim, index) => {
    if (claim.classification !== 'Unknown') {
      failValidation(
        `discussion.unresolvedQuestions[${index}].classification`,
        'must be Unknown so unresolved questions remain non-blocking',
      );
    }
  });
}

function validateStageSemantics(stage, discussion) {
  if (stage === 'scaffold') return;
  validateCompleteAnalysis(discussion);
  const unresolved = discussion.decisions.filter((decision) => decision.status === 'unresolved');
  if (stage === 'discussion') {
    if (unresolved.length !== 1) {
      failValidation('discussion.decisions', 'discussion stage requires exactly one unresolved decision');
    }
    if (discussion.executablePlan.length !== 0) {
      failValidation('discussion.executablePlan', 'must be empty until the discussion decision is resolved');
    }
    return;
  }
  if (unresolved.length !== 0) {
    failValidation('discussion.decisions', 'final stage requires zero unresolved decisions');
  }
  if (discussion.decisions.length === 0) {
    failValidation('discussion.decisions', 'final stage requires at least one resolved decision');
  }
  if (discussion.executablePlan.length === 0) {
    failValidation('discussion.executablePlan', 'final stage requires at least one plan step');
  }
  discussion.executablePlan.forEach((step, index) => {
    requireEvidenceSpecificClaims(step.claims, `discussion.executablePlan[${index}].claims`);
  });
}

export function validatePacket(packet) {
  requireObject(packet, 'packet');
  if (packet.schemaVersion !== SCHEMA_VERSION) {
    failValidation('schemaVersion', `must equal ${SCHEMA_VERSION}`);
  }
  if (!PACKET_STAGES.has(packet.stage)) {
    failValidation('stage', 'must be scaffold, discussion, or final');
  }
  requireString(packet.goal, 'goal');
  if (Buffer.byteLength(packet.goal, 'utf8') > LIMITS.goalBytes) failValidation('goal', 'exceeds size limit');
  const repository = requireObject(packet.repository, 'repository');
  requireString(repository.root, 'repository.root');
  if (!isAbsolute(repository.root) || repository.root.includes('\\')) {
    failValidation('repository.root', 'must be an absolute normalized path');
  }
  const repoRoot = resolveDirectory(repository.root, 'packet repository');
  if (normalizePath(repoRoot) !== repository.root) {
    failValidation('repository.root', 'must be a canonical real path');
  }
  const git = requireObject(repository.git, 'repository.git');
  if (git.branch !== null && typeof git.branch !== 'string') failValidation('repository.git.branch', 'must be string or null');
  if (git.head !== null && (typeof git.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(git.head))) {
    failValidation('repository.git.head', 'must be a Git object hash or null');
  }
  const status = requireArray(git.status, 'repository.git.status');
  status.forEach((value, index) => {
    const path = `repository.git.status[${index}]`;
    const item = requireObject(value, path);
    if (!PORCELAIN_STATUS_CODES.has(item.code)) {
      failValidation(`${path}.code`, 'must be a valid porcelain-v1 XY status');
    }
    requireString(item.path, `${path}.path`);
    if (!isNormalizedRepositoryPath(item.path)) {
      failValidation(`${path}.path`, 'must be a normalized repository-relative POSIX path');
    }
    if (item.originalPath !== null && typeof item.originalPath !== 'string') {
      failValidation(`${path}.originalPath`, 'must be a string or null');
    }
    const renamedOrCopied = item.code.includes('R') || item.code.includes('C');
    if (renamedOrCopied && !isNormalizedRepositoryPath(item.originalPath)) {
      failValidation(`${path}.originalPath`, 'must be a normalized repository-relative POSIX path for a rename or copy');
    }
    if (!renamedOrCopied && item.originalPath !== null) {
      failValidation(`${path}.originalPath`, 'must be null unless the entry is a rename or copy');
    }
    if (index > 0 && compareGitStatus(status[index - 1], item) > 0) {
      failValidation('repository.git.status', 'must be sorted');
    }
  });

  const evidence = validateSources(packet, repoRoot);
  const discussion = requireObject(packet.discussion, 'discussion');
  for (const category of REQUIRED_DISCUSSION_CATEGORIES) {
    if (!(category in discussion)) failValidation('discussion', `missing required category ${category}`);
  }
  const context = { ...evidence, claimIds: new Set() };
  for (const category of CLAIM_CATEGORIES) {
    validateClaimArray(discussion[category], `discussion.${category}`, context);
  }
  const scope = requireObject(discussion.scope, 'discussion.scope');
  validateClaimArray(scope.in, 'discussion.scope.in', context);
  validateClaimArray(scope.out, 'discussion.scope.out', context);
  validateOptions(discussion.options, context);
  validateDecisions(discussion.decisions, context);
  const criterionIds = validateSuccessCriteria(discussion.successCriteria);
  validatePlan(discussion.executablePlan, criterionIds, context);
  validateStageSemantics(packet.stage, discussion);
  return packet;
}

export function readPacket(packetPath) {
  const absolute = resolve(packetPath);
  const buffer = readBoundedFile(absolute, LIMITS.packetBytes, 'packet', InputError);
  let packet;
  try {
    packet = JSON.parse(decodeUtf8(buffer, 'packet'));
  } catch (error) {
    if (error instanceof DriverError) throw error;
    throw new InputError(`packet is not valid JSON: ${error.message}`);
  }
  return packet;
}

function assertSafeOutput(outputPath, repoRoot) {
  const absolute = resolve(outputPath);
  if (isWithin(repoRoot, absolute)) throw new SafetyError('output path must be outside the target repository');
  const parent = dirname(absolute);
  let realParent;
  try {
    realParent = realpathSync(parent);
  } catch (error) {
    throw new IoError(`output parent does not exist: ${parent} (${error.code ?? 'error'})`);
  }
  if (isWithin(repoRoot, realParent)) throw new SafetyError('output path must be outside the target repository');
  try {
    const stats = lstatSync(absolute);
    const realOutput = realpathSync(absolute);
    if (stats.isDirectory()) throw new IoError(`output path is a directory: ${absolute}`);
    if (isWithin(repoRoot, realOutput)) throw new SafetyError('output path resolves inside the target repository');
  } catch (error) {
    if (error instanceof DriverError) throw error;
    if (error.code !== 'ENOENT') throw new IoError(`cannot inspect output path: ${absolute} (${error.code ?? 'error'})`);
  }
  return { absolute, realParent };
}

export function writePacketAtomic(outputPath, repoRoot, packet) {
  const { absolute, realParent } = assertSafeOutput(outputPath, repoRoot);
  const json = canonicalJson(packet);
  if (Buffer.byteLength(json, 'utf8') > LIMITS.packetBytes) throw new InputError('packet output exceeds size limit');
  const tempPath = resolve(realParent, `.${basename(absolute)}.tmp-${process.pid}`);
  let tempCreated = false;
  try {
    writeFileSync(tempPath, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    tempCreated = true;
    renameSync(tempPath, absolute);
  } catch (error) {
    if (tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
    throw new IoError(`could not atomically write output: ${absolute} (${error.code ?? 'error'})`);
  }
}

function parseCollectArgs(args) {
  let repo;
  let goal;
  let out;
  const evidence = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--repo' || token === '--goal' || token === '--out') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${token} requires a value`);
      if (token === '--repo') {
        if (repo !== undefined) throw new UsageError('--repo may be specified only once');
        repo = value;
      } else if (token === '--goal') {
        if (goal !== undefined) throw new UsageError('--goal may be specified only once');
        goal = value;
      } else {
        if (out !== undefined) throw new UsageError('--out may be specified only once');
        out = value;
      }
    } else if (token === '--evidence') {
      let count = 0;
      while (args[index + 1] !== undefined && !args[index + 1].startsWith('--')) {
        evidence.push(args[++index]);
        count += 1;
      }
      if (count === 0) throw new UsageError('--evidence requires one or more role=path values');
    } else {
      throw new UsageError(`unknown collect argument: ${token}`);
    }
  }
  if (repo === undefined) throw new UsageError('collect requires --repo <path>');
  if (goal === undefined) throw new UsageError('collect requires --goal <text>');
  return { evidence, goal, out, repo };
}

function parseSinglePathArgs(command, args, flag) {
  if (args.length !== 2 || args[0] !== flag || args[1].startsWith('--')) {
    throw new UsageError(`${command} requires ${flag} <path>`);
  }
  return args[1];
}

function targetSnapshot(repoRoot) {
  const gitStatus = boundedExec('git', [
    '-C',
    repoRoot,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  return gitStatus === null ? null : sha256(gitStatus);
}

function smokeDiscussionPacket(scaffold) {
  const packet = structuredClone(scaffold);
  const evidenceCitation = structuredClone(scaffold.discussion.currentMechanisms[0].citations[0]);
  const claim = (id, classification, statement) => ({
    citations: classification === 'Unknown' ? [] : [structuredClone(evidenceCitation)],
    classification,
    id,
    statement,
  });
  packet.stage = 'discussion';
  packet.discussion = {
    constraints: [claim('C17', 'Inference', 'The design is constrained to the recorded local mechanism.')],
    currentMechanisms: [claim('C4', 'Fact', 'The fixture records the current mechanism on its first line.')],
    decisions: [
      {
        answer: null,
        id: 'D1',
        question: 'Which fixture-backed option should be selected?',
        rationale: [claim('C12', 'Inference', 'The fixture supports comparing the two local options.')],
        status: 'unresolved',
      },
    ],
    executablePlan: [],
    goal: [claim('C1', 'Fact', 'The fixture provides evidence for a deterministic local design discussion.')],
    localImplementation: [claim('C5', 'Fact', 'The local implementation must preserve the recorded mechanism.')],
    options: [
      {
        claims: [claim('C7', 'Fact', 'Option one retains the recorded mechanism directly.')],
        id: 'O1',
        title: 'Retain the mechanism',
        tradeoffs: [claim('C8', 'Inference', 'Direct retention minimizes local divergence.')],
      },
      {
        claims: [claim('C9', 'Inference', 'Option two wraps the mechanism behind a local boundary.')],
        id: 'O2',
        title: 'Wrap the mechanism',
        tradeoffs: [claim('C10', 'Fact', 'The wrapper must still preserve the recorded constraint.')],
      },
    ],
    overlap: [claim('C6', 'Inference', 'Both options overlap at the recorded mechanism boundary.')],
    recommendation: [claim('C11', 'Inference', 'Option one is recommended because it minimizes divergence.')],
    risks: [claim('C14', 'Inference', 'Changing the recorded mechanism could invalidate the local design.')],
    scope: {
      in: [claim('C2', 'Fact', 'The recorded mechanism is in scope.')],
      out: [claim('C3', 'Inference', 'Unrecorded external systems are outside the evidenced scope.')],
    },
    successCriteria: [
      {
        criterion: 'The selected option preserves the recorded mechanism.',
        id: 'SC1',
        verification: 'Compare the implementation behavior with the evidence fixture.',
      },
      {
        criterion: 'The final packet remains deterministically valid.',
        id: 'SC2',
        verification: 'Run packet validation and require a successful final-stage result.',
      },
    ],
    unresolvedQuestions: [claim('C13', 'Unknown', 'Could a non-blocking future constraint change the trade-off?')],
  };
  return packet;
}

function smokeFinalPacket(discussionPacket) {
  const packet = structuredClone(discussionPacket);
  const evidenceCitation = structuredClone(packet.discussion.currentMechanisms[0].citations[0]);
  const planClaim = (id, statement) => ({
    citations: [structuredClone(evidenceCitation)],
    classification: 'Inference',
    id,
    statement,
  });
  packet.stage = 'final';
  packet.discussion.decisions[0] = {
    answer: 'Select O1.',
    id: 'D1',
    question: 'Which fixture-backed option should be selected?',
    rationale: [planClaim('C12', 'The fixture supports selecting the direct-retention option.')],
    status: 'resolved',
  };
  packet.discussion.executablePlan = [
    {
      action: 'Implement the direct-retention option.',
      claims: [planClaim('C15', 'The first implementation step preserves the recorded mechanism.')],
      dependsOn: [],
      id: 'P1',
      successCriteria: ['SC1'],
      verification: 'Compare implementation behavior with the evidence fixture.',
    },
    {
      action: 'Validate the completed implementation packet.',
      claims: [planClaim('C16', 'Validation confirms the evidence-backed design remains consistent.')],
      dependsOn: ['P1'],
      id: 'P2',
      successCriteria: ['SC2'],
      verification: 'Run final-stage packet validation and require success.',
    },
  ];
  return packet;
}

export function runSmoke(targetRepo) {
  const targetRoot = resolveDirectory(targetRepo, 'smoke repository');
  const before = targetSnapshot(targetRoot);
  const smokeRoot = mkdtempSync(resolve(tmpdir(), SMOKE_PREFIX));
  let checks;
  try {
    const fixtureRepo = resolve(smokeRoot, 'fixture');
    mkdirSync(fixtureRepo);
    const evidencePath = resolve(fixtureRepo, 'evidence.txt');
    writeFileSync(evidencePath, 'mechanism one\nconstraint two\n', 'utf8');
    const options = {
      evidence: ['mechanism=evidence.txt'],
      goal: 'Choose a deterministic local implementation.',
      repo: fixtureRepo,
    };
    const scaffold = collectPacket(options);
    validatePacket(scaffold);
    const second = collectPacket(options);
    if (canonicalJson(scaffold) !== canonicalJson(second)) throw new SmokeError('deterministic collection check failed');
    const discussion = smokeDiscussionPacket(scaffold);
    validatePacket(discussion);
    const final = smokeFinalPacket(discussion);
    validatePacket(final);

    const packetPath = resolve(smokeRoot, 'packet.json');
    writePacketAtomic(packetPath, fixtureRepo, final);
    validatePacket(readPacket(packetPath));
    writeFileSync(evidencePath, 'mechanism changed\nconstraint two\n', 'utf8');
    let staleRejected = false;
    try {
      validatePacket(final);
    } catch (error) {
      if (error instanceof PacketValidationError) staleRejected = true;
      else throw error;
    }
    if (!staleRejected) throw new SmokeError('stale evidence was not rejected');
    checks = {
      deterministicCollection: true,
      discussionValidation: true,
      finalValidation: true,
      fixtureCleanup: true,
      scaffoldValidation: true,
      staleEvidenceRejection: true,
      targetNonMutation: true,
    };
  } finally {
    rmSync(smokeRoot, { force: true, recursive: true });
  }
  const after = targetSnapshot(targetRoot);
  if (before !== after) throw new SmokeError('target repository changed during smoke run');
  return { checks, ok: true };
}

export function usageText() {
  return [
    'Usage:',
    '  driver.mjs collect --repo <path> --goal <text> --evidence role=path... [--out <path>]',
    '  driver.mjs validate --packet <path>',
    '  driver.mjs smoke --repo <path>',
    '',
    'Exit classes:',
    '  0 success',
    '  2 usage error',
    '  3 bounded input or parse error',
    '  4 packet validation error',
    '  5 filesystem or process I/O error',
    '  6 repository safety violation',
    '  7 smoke verification failure',
  ].join('\n');
}

export function runCli(argv, io = { stderr: process.stderr, stdout: process.stdout }) {
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h') {
    io.stdout.write(`${usageText()}\n`);
    return EXIT.OK;
  }
  if (command === 'collect') {
    const options = parseCollectArgs(args);
    const packet = collectPacket(options);
    validatePacket(packet);
    if (options.out === undefined) io.stdout.write(canonicalJson(packet));
    else writePacketAtomic(options.out, realpathSync(resolve(options.repo)), packet);
    return EXIT.OK;
  }
  if (command === 'validate') {
    const packetPath = parseSinglePathArgs(command, args, '--packet');
    const packet = readPacket(packetPath);
    validatePacket(packet);
    io.stdout.write(canonicalJson({ ok: true, stage: packet.stage }));
    return EXIT.OK;
  }
  if (command === 'smoke') {
    const repo = parseSinglePathArgs(command, args, '--repo');
    io.stdout.write(canonicalJson(runSmoke(repo)));
    return EXIT.OK;
  }
  throw new UsageError(command === undefined ? 'a command is required' : `unknown command: ${command}`);
}

function main() {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof DriverError) {
      process.stderr.write(`${error.label}: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`internal-error: ${error.message}\n`);
    process.exitCode = EXIT.IO;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
