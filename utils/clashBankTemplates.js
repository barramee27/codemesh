/**
 * Pre-built Clash problems (bank). Picked at random when creating a room with source bank/auto.
 * Each template is validated shape: title, statement, samples[], tests[], allowedLanguages.
 */

const TEMPLATES = {
    reverse: [
        {
            title: 'Uppercase',
            statement: '',
            samples: [
                { input: 'hello', output: 'HELLO' },
                { input: 'CodeMesh', output: 'CODEMESH' }
            ],
            tests: [
                { input: 'a', output: 'A', hidden: false },
                { input: 'z9', output: 'Z9', hidden: false },
                { input: 'Mixed_Case_123', output: 'MIXED_CASE_123', hidden: true },
                { input: 'x', output: 'X', hidden: true }
            ],
            allowedLanguages: ['python', 'javascript', 'typescript', 'cpp', 'java', 'go', 'rust', 'php', 'ruby', 'csharp']
        }
    ],
    fastest: [
        {
            title: 'Sum two integers',
            statement: 'The first line contains two integers A and B separated by space. Print A + B.',
            samples: [{ input: '1 2', output: '3' }, { input: '10 -3', output: '7' }],
            tests: [
                { input: '0 0', output: '0', hidden: false },
                { input: '100 200', output: '300', hidden: false },
                { input: '-50 50', output: '0', hidden: true },
                { input: '999999 1', output: '1000000', hidden: true }
            ],
            allowedLanguages: ['python', 'javascript', 'typescript', 'cpp', 'java', 'go', 'rust', 'php', 'ruby', 'csharp']
        }
    ],
    shortest: [
        {
            title: 'Echo first line',
            statement: 'Read one line from stdin and print it unchanged.',
            samples: [{ input: 'hello', output: 'hello' }],
            tests: [
                { input: 'x', output: 'x', hidden: false },
                { input: 'two words', output: 'two words', hidden: false },
                { input: 'hidden_line_test', output: 'hidden_line_test', hidden: true },
                { input: '42', output: '42', hidden: true }
            ],
            allowedLanguages: ['python', 'javascript', 'typescript', 'cpp', 'java', 'go', 'rust', 'php', 'ruby', 'csharp']
        }
    ]
};

function pickRandomTemplate(mode) {
    const list = TEMPLATES[mode] || TEMPLATES.fastest;
    const raw = list[Math.floor(Math.random() * list.length)];
    return JSON.parse(JSON.stringify(raw));
}

module.exports = { pickRandomTemplate, TEMPLATES };
