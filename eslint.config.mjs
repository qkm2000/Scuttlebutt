import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
	{
		ignores: [
			'main.js',
			'main.js.map',
			'node_modules/**',
			'.test-out/**',
			'esbuild.js',
			'esbuild.test.js',
			'eslint.config.mjs',
			// Tests run under Node's test runner, aren't shipped, and aren't in the
			// src-only tsconfig, so keep them out of the type-aware project lint.
			'tests/**',
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Sentence-case UI text, but preserve our proper nouns and the exact-cased UI
			// labels we reference ("New", "Save audio"), and skip strings that aren't prose:
			// URL / API-key placeholders and the language-code example list.
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					brands: [
						'Scuttlebutt',
						'English',
						'Markdown',
						'Whisper',
						'WhisperX',
						'vLLM',
						'Obsidian',
						'BlackHole',
						'New',
						'Save audio',
					],
					ignoreRegex: ['^https?://', '^sk-', '\\(e\\.g\\.'],
				},
			],
		},
	},
];
