import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyTemplate,
	buildMultipart,
	calloutBlock,
	formatDiarizedSegments,
	formatDuration,
	isNewerVersion,
	joinUrl,
	normalizeTag,
	parseTagArray,
	parseTranscriptResponse,
	reasoningParams,
	recordedMs,
	responseHasSpeakers,
	sanitizeFileName,
	sanitizeTitle,
	splitReasoning,
	stripCodeFences,
	stripThink,
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

test('stripThink removes complete, truncated, and orphan-close think blocks', () => {
	assert.equal(stripThink('<think>reasoning here</think>\n# Answer'), '# Answer');
	assert.equal(stripThink('before <think>mid</think> after'), 'before  after');
	// Truncated mid-think (no closing tag): the reasoning is dropped, leaving nothing.
	assert.equal(stripThink('<think>still thinking and cut off'), '');
	// Reasoning parser consumed the opening tag, leaving only the close.
	assert.equal(stripThink('reasoning text</think>\nThe real answer'), 'The real answer');
	// Plain content is untouched.
	assert.equal(stripThink('# Just a summary\n- a'), '# Just a summary\n- a');
});

test('splitReasoning separates answer from thinking across all tag shapes', () => {
	assert.deepEqual(splitReasoning('<think>hmm</think>\n# Answer'), { answer: '# Answer', reasoning: 'hmm' });
	// Dangling open (still streaming / truncated): answer so far, rest is reasoning.
	assert.deepEqual(splitReasoning('intro <think>still going'), { answer: 'intro', reasoning: 'still going' });
	// Orphan close (parser consumed the open tag): before is reasoning, after is answer.
	assert.deepEqual(splitReasoning('reasoning</think>real answer'), {
		answer: 'real answer',
		reasoning: 'reasoning',
	});
	// No tags at all.
	assert.deepEqual(splitReasoning('just an answer'), { answer: 'just an answer', reasoning: '' });
});

test('reasoningParams disables thinking when off and reserves headroom otherwise', () => {
	const off = reasoningParams('off');
	assert.equal(off.headroom, 0);
	assert.deepEqual(off.params, { chat_template_kwargs: { enable_thinking: false } });
	assert.equal((off.params as any).reasoning_effort, undefined);

	const high = reasoningParams('high');
	assert.equal(high.headroom, 8192);
	assert.equal((high.params as any).reasoning_effort, 'high');
	assert.deepEqual((high.params as any).chat_template_kwargs, { enable_thinking: true });

	// Headroom scales with the effort ladder.
	assert.ok(reasoningParams('low').headroom < reasoningParams('max').headroom);
	assert.equal(reasoningParams('max').headroom, 32768);
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

test('parseTranscriptResponse renders diarized segments as speaker turns', () => {
	const body = JSON.stringify({
		text: 'hello hi there bye',
		segments: [
			{ text: 'hello', speaker: 'SPEAKER_00' },
			{ text: 'hi there', speaker: 'SPEAKER_01' },
			{ text: 'bye', speaker: 'SPEAKER_00' },
		],
	});
	// Raw labels are renamed by first appearance; the flat `text` is ignored.
	assert.equal(parseTranscriptResponse(body), 'Speaker 1: hello\nSpeaker 2: hi there\nSpeaker 1: bye');
});

test('responseHasSpeakers detects speaker labels only when present', () => {
	assert.equal(responseHasSpeakers('{"segments":[{"text":"a","speaker":"SPEAKER_00"}]}'), true);
	// vLLM-style: segments with timestamps but no speaker field.
	assert.equal(responseHasSpeakers('{"text":"a","segments":[{"text":"a","start":0}]}'), false);
	assert.equal(responseHasSpeakers('{"text":"a"}'), false);
	assert.equal(responseHasSpeakers('plain text'), false);
});

test('formatDiarizedSegments merges consecutive turns and skips empties', () => {
	assert.equal(
		formatDiarizedSegments([
			{ text: 'one', speaker: 'SPEAKER_00' },
			{ text: '  ', speaker: 'SPEAKER_00' },
			{ text: 'two', speaker: 'SPEAKER_00' },
			{ text: 'three', speaker: 'SPEAKER_01' },
		]),
		'Speaker 1: one two\nSpeaker 2: three'
	);
	// A segment with no speaker falls back to a generic label rather than being dropped.
	assert.equal(formatDiarizedSegments([{ text: 'solo' }]), 'Unknown speaker: solo');
});

test('yamlString quotes only when needed', () => {
	assert.equal(yamlString('Simple'), 'Simple');
	assert.equal(yamlString('Has: colon'), '"Has: colon"');
	assert.equal(yamlString('quote"inside'), '"quote\\"inside"');
	assert.equal(yamlString(' leading'), '" leading"');
	// Backslashes must be escaped before quotes, or the double-quoted scalar is invalid YAML.
	assert.equal(yamlString('C:\\Users'), '"C:\\\\Users"');
	assert.equal(yamlString('a\\"b'), '"a\\\\\\"b"');
});

test('calloutBlock prefixes every line and handles blanks', () => {
	assert.equal(
		calloutBlock('note', 'Transcript', 'line1\n\nline2', true),
		'> [!note]- Transcript\n> line1\n>\n> line2'
	);
	assert.equal(calloutBlock('quote', 'Memo', 'x', false), '> [!quote] Memo\n> x');
});

test('structureSummary gives one title H1 + overview, demoting stray H1s', () => {
	// Prepends the title heading above a headingless overview.
	assert.equal(
		structureSummary('Overview text.\n\n## Section', 'Q3 Sync'),
		'# Q3 Sync\n\nOverview text.\n\n## Section'
	);
	// Replaces a model-emitted top heading with the title.
	assert.equal(structureSummary('# Summary\nOverview.', 'Q3 Sync'), '# Q3 Sync\nOverview.');
	// A second H1 in the body is demoted to H2; the title stays the only H1.
	assert.equal(
		structureSummary('Overview.\n# Decisions\n## Details', 'Q3 Sync'),
		'# Q3 Sync\n\nOverview.\n## Decisions\n## Details'
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

test('recordedMs sums banked time and the live segment', () => {
	assert.equal(recordedMs(0, 1000, 4000), 3000); // running: 3s into first segment
	assert.equal(recordedMs(5000, 2000, 3000), 6000); // 5s banked + 1s live
});

test('recordedMs freezes while paused (null segment)', () => {
	assert.equal(recordedMs(5000, null, 999999), 5000);
	assert.equal(recordedMs(0, null, 999999), 0);
});

test('recordedMs handles multiple banked pauses', () => {
	assert.equal(recordedMs(5000, 10000, 11500), 6500); // 5s banked + 1.5s live
});

test('recordedMs never goes negative on clock skew', () => {
	assert.equal(recordedMs(0, 5000, 4000), 0); // now < segment start
	assert.equal(recordedMs(1000, 5000, 4000), 1000); // banked kept, live clamped to 0
});

test('applyTemplate substitutes tokens and blanks unknown ones', () => {
	assert.equal(applyTemplate('{{date}} - {{title}}', { date: '2026-09-09', title: 'Sync' }), '2026-09-09 - Sync');
	assert.equal(applyTemplate('{{ title }}', { title: 'Spaced' }), 'Spaced'); // tolerant of inner spaces
	assert.equal(applyTemplate('{{title}} ({{missing}})', { title: 'X' }), 'X ()'); // unknown -> empty
	assert.equal(applyTemplate('no tokens', {}), 'no tokens');
});

test('isNewerVersion compares dotted versions', () => {
	assert.equal(isNewerVersion('1.3.0', '1.2.5'), true);
	assert.equal(isNewerVersion('1.2.10', '1.2.9'), true); // numeric, not lexical
	assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
	assert.equal(isNewerVersion('1.2.0', '1.2.0'), false); // equal
	assert.equal(isNewerVersion('1.1.9', '1.2.0'), false); // older
});

test('isNewerVersion tolerates a v-prefix and shorter versions', () => {
	assert.equal(isNewerVersion('v1.3.0', '1.2.0'), true);
	assert.equal(isNewerVersion('1.2', '1.2.0'), false); // 1.2 == 1.2.0
	assert.equal(isNewerVersion('1.2.1', '1.2'), true); // missing parts treated as 0
});

test('isNewerVersion returns false for malformed versions (never nags)', () => {
	assert.equal(isNewerVersion('latest', '1.2.0'), false);
	assert.equal(isNewerVersion('1.2.x', '1.2.0'), false);
	assert.equal(isNewerVersion('', '1.2.0'), false);
});
