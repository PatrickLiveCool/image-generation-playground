import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_SECTIONS = Object.freeze(['改动说明', '验证结果', '风险与回退']);
const VALID_TYPES = 'feat|fix|docs|refactor|test|chore|ci|perf|build|revert';
const TITLE_PATTERN = new RegExp(
  `^(${VALID_TYPES})(?:\\([^()\\s]+\\))?!?: ([^\\r\\n]+)$`,
  'u',
);
const RELEASE_TITLE_PATTERN = /^chore\(release\): release (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const RELEASE_PLEASE_MARKER = 'This PR was generated with [Release Please].';
const H2_PATTERN = /^##(?!#)[ \t]+(.+?)[ \t]*$/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/gu;
const UNCHECKED_CHECKLIST_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\[\s*\](?:\s+.*)?$/u;
const MEANINGFUL_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const PLACEHOLDER_PATTERN = /^(?:todo|tbd|fixme|n\/a|na|placeholder|your answer here|describe here|replace (?:this|me)|待填写|待补充|请填写(?:内容)?|填写(?:内容)?|暂无(?:内容)?|占位(?:符|文本)?|\[[^\]]*(?:todo|tbd|placeholder|填写|待补充)[^\]]*\]|<[^>\r\n]+>|\$\{[^}\r\n]+\}|\.{3,}|_{3,}|-{3,})$/iu;

const ERRORS = Object.freeze({
  TITLE_REQUIRED: 'PR title is required.',
  TITLE_FORMAT: 'PR title must use Conventional Commit format.',
  TITLE_DESCRIPTION: 'PR title description must be meaningful.',
  BODY_REQUIRED: 'PR body is required.',
  BODY_STRUCTURE: 'PR body must contain exactly the required H2 sections.',
  UNEXPECTED_H2: 'PR body must contain only the required H2 sections.',
  EVENT_PATH: 'GITHUB_EVENT_PATH is missing or invalid.',
  EVENT_READ: 'GitHub event payload could not be read.',
  EVENT_JSON: 'GitHub event payload is malformed JSON.',
  EVENT_SHAPE: 'GitHub event payload is malformed.',
});

const SECTION_COUNT_ERRORS = Object.freeze({
  改动说明: 'PR body must contain exactly one "## 改动说明" section.',
  验证结果: 'PR body must contain exactly one "## 验证结果" section.',
  风险与回退: 'PR body must contain exactly one "## 风险与回退" section.',
});

const SECTION_CONTENT_ERRORS = Object.freeze({
  改动说明: 'PR body section "改动说明" must contain meaningful content.',
  验证结果: 'PR body section "验证结果" must contain meaningful content.',
  风险与回退: 'PR body section "风险与回退" must contain meaningful content.',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripHtmlComments(value) {
  return value.replace(HTML_COMMENT_PATTERN, '');
}

function isPlaceholderOnly(value) {
  return PLACEHOLDER_PATTERN.test(value.trim());
}

function hasMeaningfulContent(value) {
  const content = stripHtmlComments(value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !UNCHECKED_CHECKLIST_PATTERN.test(line))
    .filter((line) => !isPlaceholderOnly(line));

  return content.some((line) => MEANINGFUL_CHARACTER_PATTERN.test(line));
}

function normalizeHeading(value) {
  return value.replace(/[ \t]+#+[ \t]*$/u, '').trim();
}

function findH2Headings(lines) {
  return lines.flatMap((line, index) => {
    const match = line.match(H2_PATTERN);
    if (!match) return [];
    return [{ index, name: normalizeHeading(match[1]) }];
  });
}

function validateTitle(title, errors) {
  if (typeof title !== 'string' || title.trim() === '') {
    errors.push(ERRORS.TITLE_REQUIRED);
    return;
  }

  const match = title.match(TITLE_PATTERN);
  if (!match || title !== title.trim()) {
    errors.push(ERRORS.TITLE_FORMAT);
    return;
  }

  if (!hasMeaningfulContent(match[2])) {
    errors.push(ERRORS.TITLE_DESCRIPTION);
  }
}

function validateBody(body, errors) {
  if (typeof body !== 'string' || body.trim() === '') {
    errors.push(ERRORS.BODY_REQUIRED);
    return;
  }

  const lines = stripHtmlComments(body).replace(/\r\n?/gu, '\n').split('\n');
  const headings = findH2Headings(lines);
  const headingNames = new Set(REQUIRED_SECTIONS);

  if (headings.some(({ name }) => !headingNames.has(name))) {
    errors.push(ERRORS.UNEXPECTED_H2);
  }

  const firstHeadingIndex = headings[0]?.index ?? lines.length;
  if (hasMeaningfulContent(lines.slice(0, firstHeadingIndex).join('\n'))) {
    errors.push(ERRORS.BODY_STRUCTURE);
  }

  for (const section of REQUIRED_SECTIONS) {
    const matchingHeadings = headings.filter(({ name }) => name === section);
    if (matchingHeadings.length !== 1) {
      errors.push(SECTION_COUNT_ERRORS[section]);
      continue;
    }

    const start = matchingHeadings[0].index + 1;
    const nextHeading = headings.find(({ index }) => index > matchingHeadings[0].index);
    const end = nextHeading?.index ?? lines.length;
    if (!hasMeaningfulContent(lines.slice(start, end).join('\n'))) {
      errors.push(SECTION_CONTENT_ERRORS[section]);
    }
  }
}

function validateAutomatedReleaseBody(input, errors) {
  const { title, body } = isRecord(input) ? input : {};
  if (typeof title !== 'string' || !RELEASE_TITLE_PATTERN.test(title)) {
    errors.push(ERRORS.TITLE_FORMAT);
  }
  if (typeof body !== 'string' || body.trim() === '') {
    errors.push(ERRORS.BODY_REQUIRED);
    return;
  }

  const lines = stripHtmlComments(body).replace(/\r\n?/gu, '\n').split('\n');
  const headings = findH2Headings(lines);
  const required = new Set(REQUIRED_SECTIONS);
  for (const section of REQUIRED_SECTIONS) {
    const matching = headings.filter(({ name }) => name === section);
    if (matching.length !== 1) {
      errors.push(SECTION_COUNT_ERRORS[section]);
      continue;
    }
    const start = matching[0].index + 1;
    const nextHeading = headings.find(({ index }) => index > matching[0].index);
    const end = nextHeading?.index ?? lines.length;
    if (!hasMeaningfulContent(lines.slice(start, end).join('\n'))) {
      errors.push(SECTION_CONTENT_ERRORS[section]);
    }
  }

  const changelogHeadings = headings.filter(({ name }) => !required.has(name));
  if (changelogHeadings.some(({ name }) => !/^\[?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\]?/u.test(name))) {
    errors.push(ERRORS.UNEXPECTED_H2);
  }
}

export function validatePullRequest(input = {}) {
  const { title, body } = isRecord(input) ? input : {};
  const errors = [];
  validateTitle(title, errors);
  validateBody(body, errors);
  return errors;
}

export function validateAutomatedReleasePullRequest(input = {}) {
  const errors = [];
  validateAutomatedReleaseBody(input, errors);
  return errors;
}

function readPullRequestFromEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (typeof eventPath !== 'string' || eventPath.trim() === '') {
    return { errors: [ERRORS.EVENT_PATH] };
  }

  let eventText;
  try {
    eventText = fs.readFileSync(eventPath, 'utf8');
  } catch {
    return { errors: [ERRORS.EVENT_READ] };
  }

  let event;
  try {
    event = JSON.parse(eventText);
  } catch {
    return { errors: [ERRORS.EVENT_JSON] };
  }

  if (
    !isRecord(event)
    || !isRecord(event.pull_request)
    || typeof event.pull_request.title !== 'string'
    || typeof event.pull_request.body !== 'string'
  ) {
    return { errors: [ERRORS.EVENT_SHAPE] };
  }

  const isAutomatedRelease = RELEASE_TITLE_PATTERN.test(event.pull_request.title)
    && event.pull_request.head?.ref?.startsWith('release-please--branches--')
    && event.pull_request.body.includes(RELEASE_PLEASE_MARKER);
  return { pullRequest: event.pull_request, isAutomatedRelease };
}

function runCli() {
  const { errors, pullRequest, isAutomatedRelease } = readPullRequestFromEvent();
  const validationErrors = errors ?? (isAutomatedRelease
    ? validateAutomatedReleasePullRequest(pullRequest)
    : validatePullRequest(pullRequest));
  if (validationErrors.length > 0) {
    process.stderr.write(`${validationErrors.join('\n')}\n`);
    return 1;
  }
  return 0;
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFile === invokedFile) {
  process.exitCode = runCli();
}
