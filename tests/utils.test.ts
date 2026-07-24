import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildMultipart,
	calloutBlock,
	formatDuration,
	joinUrl,
	normalizeTag,
	parseTagArray,
	parseTranscriptResponse,
	sanitizeFileName,
	sanitizeTitle,
	stripCodeFences,
	structureSummary,
	todayStamp,
	truncate,
	yamlString,
} from '../src/utils';

test('joinUrl collapses slashes between base and path', () => {
	assert.equal(joinUrl('http://x/v1', 'models'), 'http://x/v1/models');
	assert.equal(joinUrl('http://x/v1/', '/models'), 'http://x/v1/models');
	assert.equal(joinUrl('http://x/v1///', '///audio/transcriptions'), 'http://x/v1/audio/transcriptions');
});

test('truncate adds an ellipsis only past the limit', () => {
	assert.equal(truncate('', 10), '');
	assert.equal(truncate('short', 10), 'short');
	assert.equal(truncate('abcdefghij', 5), 'abcde…');
});

test('formatDuration renders m:ss and h:mm:ss', () => {
	assert.equal(formatDuration(0), '0:00');
	assert.equal(formatDuration(5_000), '0:05');
	assert.equal(formatDuration(65_000), '1:05');
	assert.equal(formatDuration(3_661_000), '1:01:01');
	assert.equal(formatDuration(-1000), '0:00');
});

test('todayStamp is zero-padded local YYYY-MM-DD', () => {
	assert.equal(todayStamp(new Date(2026, 0, 5)), '2026-01-05');
	assert.equal(todayStamp(new Date(2026, 11, 31)), '2026-12-31');
});

test('sanitizeTitle strips forbidden punctuation and collapses whitespace', () => {
	assert.equal(sanitizeTitle('Q3 Roadmap: Sync (v2)'), 'Q3 Roadmap Sync v2');
	assert.equal(sanitizeTitle('  "Kickoff"  call  '), 'Kickoff call');
	assert.equal(sanitizeTitle('a/b\\c'), 'abc');
});

test('sanitizeFileName removes reserved chars and falls back to Meeting', () => {
	assert.equal(sanitizeFileName('a/b:c*?"<>|'), 'abc');
	assert.equal(sanitizeFileName('   '), 'Meeting');
	assert.equal(sanitizeFileName(''), 'Meeting');
	assert.equal(sanitizeFileName('x'.repeat(200)).length, 120);
});

test('normalizeTag yields a valid, readable Obsidian tag', () => {
	assert.equal(normalizeTag('#User Interview'), 'User-Interview');
	assert.equal(normalizeTag('  Product  '), 'Product');
	assert.equal(normalizeTag('a!!b'), 'ab');
	assert.equal(normalizeTag('--x--'), 'x');
	assert.equal(normalizeTag('foo/bar'), 'foo/bar');
	assert.equal(normalizeTag('###'), '');
});

test('stripCodeFences unwraps a fenced block, leaves plain text alone', () => {
	assert.equal(stripCodeFences('```markdown\n# Hi\n```'), '# Hi');
	assert.equal(stripCodeFences('```\nx\n```'), 'x');
	assert.equal(stripCodeFences('# Hi\n- a'), '# Hi\n- a');
});

test('parseTagArray extracts arrays, even from surrounding prose', () => {
	assert.deepEqual(parseTagArray('["a","b"]'), ['a', 'b']);
	assert.deepEqual(parseTagArray('Sure! ["x", "y"] hope that helps'), ['x', 'y']);
	assert.deepEqual(parseTagArray('[1, 2]'), ['1', '2']);
	assert.deepEqual(parseTagArray('no array here'), []);
});

test('parseTranscriptResponse tolerates many response shapes', () => {
	assert.equal(parseTranscriptResponse('{"text":"  hello  "}'), 'hello');
	assert.equal(parseTranscriptResponse('plain text'), 'plain text');
	assert.equal(parseTranscriptResponse('{"segments":[{"text":"a"},{"text":"b"}]}'), 'a b');
	assert.equal(parseTranscriptResponse('{"transcript":"c"}'), 'c');
	assert.equal(
		parseTranscriptResponse('{"results":{"channels":[{"alternatives":[{"transcript":"deep"}]}]}}'),
		'deep'
	);
});

test('yamlString quotes only when needed', () => {
	assert.equal(yamlString('Simple'), 'Simple');
	assert.equal(yamlString('Has: colon'), '"Has: colon"');
	assert.equal(yamlString('quote"inside'), '"quote\\"inside"');
	assert.equal(yamlString(' leading'), '" leading"');
});

test('calloutBlock prefixes every line and handles blanks', () => {
	assert.equal(
		calloutBlock('note', 'Transcript', 'line1\n\nline2', true),
		'> [!note]- Transcript\n> line1\n>\n> line2'
	);
	assert.equal(calloutBlock('quote', 'Memo', 'x', false), '> [!quote] Memo\n> x');
});

test('structureSummary enforces one leading H1 and demotes stray H1s', () => {
	// Replaces the first H1 with the chosen heading.
	assert.equal(structureSummary('# Overview\n- point', 'Summary'), '# Summary\n- point');
	// Uses the title when provided.
	assert.equal(structureSummary('# Whatever\ntext', 'Q3 Sync'), '# Q3 Sync\ntext');
	// Prepends a heading when the summary has none.
	assert.equal(structureSummary('Hello\n## Section', 'Summary'), '# Summary\n\nHello\n## Section');
	// Demotes a later H1 to H2, keeps existing H2s.
	assert.equal(
		structureSummary('# Summary\n\nOverview line\n# Decisions\n## Details', 'Summary'),
		'# Summary\n\nOverview line\n## Decisions\n## Details'
	);
});

test('buildMultipart produces a well-formed body and boundary', () => {
	const data = new Uint8Array([1, 2, 3, 4]).buffer;
	const { body, contentType } = buildMultipart(
		{ model: 'whisper-1', language: 'en' },
		{ field: 'file', filename: 'a.webm', type: 'audio/webm', data }
	);
	assert.match(contentType, /^multipart\/form-data; boundary=----Scuttlebutt/);
	assert.ok(body instanceof ArrayBuffer);

	const boundary = contentType.split('boundary=')[1];
	const decoded = new TextDecoder('utf-8', { fatal: false }).decode(body);
	assert.ok(decoded.includes('name="model"'));
	assert.ok(decoded.includes('whisper-1'));
	assert.ok(decoded.includes('name="language"'));
	assert.ok(decoded.includes('name="file"; filename="a.webm"'));
	assert.ok(decoded.includes('Content-Type: audio/webm'));
	assert.ok(decoded.includes(`--${boundary}--`));
});
