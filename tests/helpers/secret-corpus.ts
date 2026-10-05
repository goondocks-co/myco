/**
 * The adversarial corpus every path that stores a command-shaped string, or a failed call's outcome, is judged by:
 * each input an adversarial probe found a secret surviving in, and the values of it no stored output may hold.
 */

/** Token-shaped values, assembled so the source holds no literal a secret scanner reads as a live credential. */
export const STRIPE_LIVE = ['rk', 'live', '51HxQwErTyUiOpAsDfGhJkL'].join('_');
export const OPENAI_KEY = ['sk', 'proj', 'Zx81Qw2Er3Ty4Ui5Op6As7Df8Gh9Jk0'].join('-');
export const GITHUB_PAT = ['ghp', 'R4nd0mT0k3nV4lu3Abcdefghij0123456789'].join('_');
export const SLACK_BOT = ['xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
export const GITLAB_PAT = ['glpat', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'].join('-');
export const AWS_KEY_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
export const AWS_SECRET = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
export const BARE_JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
export const BASE64_SECRET = 'c3VwZXItc2VjcmV0LXZhbHVlLTQyCg==';
export const UUID_KEY = '550e8400-e29b-41d4-a716-446655440000';

export interface Leak { name: string; command: string; secrets: readonly string[] }

/** Each input, and the values of it no path may ever store. */
export const CORPUS: readonly Leak[] = [
  { name: 'an explicit slash-bearing search pattern', command: 'rg -e private/customer-note src/', secrets: ['private/customer-note'] },
  { name: 'an unknown value shaped like a search mode', command: 'rg --message --files private/customer-note', secrets: ['private/customer-note'] },
  { name: 'an unknown short-cluster value', command: 'ls -lhZ private/customer-note src/', secrets: ['private/customer-note'] },
  { name: 'a slash-bearing printf payload', command: 'printf %s private/customer-note', secrets: ['private/customer-note'] },
  { name: 'a slash-bearing data flag value', command: 'curl --data private/customer-note https://fixture.invalid', secrets: ['private/customer-note'] },
  { name: 'a file-shaped data flag value', command: 'curl --data customer-note.json https://fixture.invalid', secrets: ['customer-note.json'] },
  { name: 'an unknown flag value', command: 'tool --message private/customer-note', secrets: ['private/customer-note'] },
  { name: 'a slash-bearing search pattern', command: 'rg -n private/customer-note src/', secrets: ['private/customer-note'] },
  { name: 'a file-shaped search pattern', command: 'grep -i customer-note.json src/a.ts', secrets: ['customer-note.json'] },
  { name: 'a slash-bearing unknown positional', command: 'tool private/customer-note', secrets: ['private/customer-note'] },
  { name: 'an application payload after its script', command: 'node app.js private/customer-note', secrets: ['private/customer-note'] },
  { name: 'a payload after a runtime eval flag', command: 'node -e ignored private/customer-note', secrets: ['private/customer-note'] },
  { name: 'a payload forwarded to an npm test script', command: 'npm test -- private/customer-note', secrets: ['private/customer-note'] },
  { name: 'a path-shaped test filter', command: 'bun test private/customer-note', secrets: ['private/customer-note'] },
  // Plain and short positional words.
  { name: 'a plain word echoed', command: 'echo S3cret', secrets: ['S3cret'] },
  { name: 'a lowercase word echoed', command: 'echo letmein77', secrets: ['letmein77'] },
  { name: 'a quoted literal echoed', command: "echo 'literal-secret-value-123456'", secrets: ['literal-secret-value', '123456'] },
  { name: 'a double-quoted secret', command: 'echo "hunter2pass"', secrets: ['hunter2pass'] },
  { name: 'an htpasswd password', command: 'htpasswd -b f user S3cret', secrets: ['S3cret'] },
  { name: 'a Redis AUTH', command: 'redis-cli AUTH S3cret', secrets: ['S3cret', 'AUTH'] },
  { name: 'an ssh trailing word', command: 'ssh user@host S3cret', secrets: ['S3cret', 'user@'] },
  { name: 'a word after the end of flags', command: 'tool -- S3cret', secrets: ['S3cret'] },
  { name: 'a password piped to sudo', command: 'echo S3cret | sudo -S cmd', secrets: ['S3cret'] },
  { name: 'a short secret of six', command: 'login --user me qwerty', secrets: ['qwerty'] },
  { name: 'a short secret of twelve', command: 'unlock vault Tr0ub4dor&3x', secrets: ['Tr0ub4dor'] },
  { name: 'a lowercase word after a subcommand program flag', command: 'docker -p lowercasesecret', secrets: ['lowercasesecret'] },
  { name: 'a lowercase second word of a subcommand program', command: 'make deploy hunter22', secrets: ['hunter22'] },
  // Single-dash long flags.
  { name: 'a single-dash password flag', command: 'tool -password S3cret', secrets: ['S3cret', 'assword'] },
  { name: 'an openssl passin', command: 'openssl rsa -passin S3cret -in key.pem', secrets: ['S3cret'] },
  { name: 'an openssl pass', command: 'openssl enc -pass S3cret -in a.txt', secrets: ['S3cret'] },
  { name: 'an openssl pass with its source', command: 'openssl enc -aes-256-cbc -pass pass:S3cret -in a.txt', secrets: ['S3cret', 'pass:'] },
  { name: 'a single-dash token flag', command: 'tool -token abc', secrets: ['abc', 'oken'] },
  // Redirections and here-strings.
  { name: 'a here-string', command: 'cat <<< S3cretpass', secrets: ['S3cretpass'] },
  { name: 'a glued here-string', command: 'cat <<<S3cretpass', secrets: ['S3cretpass'] },
  { name: 'a here-string piped on', command: 'base64 -d <<< c2VjcmV0 | sh', secrets: ['c2VjcmV0'] },
  { name: 'a path-like word after a redirection', command: 'cat > secrets/prod.env', secrets: ['secrets/prod.env'] },
  // Line breaks a here-document or a second command hides behind.
  { name: 'a here-document after \\n', command: `cat > .env <<'EOF'\nSTRIPE_KEY=${STRIPE_LIVE}\nDATABASE_URL=postgres://admin:S3cret@db\nEOF`, secrets: ['rk_live', 'S3cret', 'admin', 'DATABASE_URL'] },
  { name: 'a here-document after \\r', command: 'cat <<EOF\rS3cret\rEOF', secrets: ['S3cret'] },
  { name: 'a here-document after U+2028', command: 'cat <<EOF\u2028token=S3cret\u2028EOF', secrets: ['S3cret', 'token'] },
  { name: 'a second command after U+2029', command: 'true\u2029echo hunter22', secrets: ['hunter22'] },
  { name: 'a second command after U+0085', command: 'true\u0085echo hunter22', secrets: ['hunter22'] },
  { name: 'a second command after VT', command: 'true\u000becho hunter22', secrets: ['hunter22'] },
  { name: 'a second command after FF', command: 'true\u000cecho hunter22', secrets: ['hunter22'] },
  ...['\\u2028', '\\u2029', '\\u0085', '\\u000b', '\\u000c'].map((code): Leak => ({
    name: `a key file named on the line after ${code}`,
    command: `true${String.fromCharCode(Number.parseInt(code.slice(2), 16))}cat vault/prod-signing.pem`,
    secrets: ['prod-signing'],
  })),
  // URLs.
  { name: 'an @ inside a URL password', command: 'curl https://user:pa@ss@host.example.test/x', secrets: ['pa@ss', 'ss@', 'user'] },
  { name: 'a / inside a URL password', command: 'curl https://user:pa/ss@host.example.test/x', secrets: ['pa/ss', 'user:'] },
  { name: 'a postgres URL with credentials', command: 'psql postgres://admin:S3cret@db.internal:5432/app', secrets: ['S3cret', 'admin'] },
  { name: 'a quoted postgresql URL', command: 'psql "postgresql://admin:S3cret@db.internal/app"', secrets: ['S3cret', 'admin'] },
  { name: 'a mongodb+srv URL with credentials', command: 'mongosh "mongodb+srv://root:Pa55word@cluster0.example.test/db"', secrets: ['Pa55word', 'root'] },
  { name: 'keys in a query string', command: 'curl "https://api.example.test/v1?key=AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv&token=t0kenValue"', secrets: ['AIza', 't0kenValue', 'key='] },
  { name: 'a token in a clone URL', command: `git clone https://user:${GITHUB_PAT}@github.com/org/repo.git`, secrets: ['ghp_', 'R4nd0m', 'user:'] },
  { name: 'a GitLab token in a remote', command: `git push https://oauth2:${GITLAB_PAT}@gitlab.example.test/x.git`, secrets: ['glpat', 'oauth2'] },
  { name: 'credentials in an ssh URL', command: 'git clone ssh://git:tok3nValue@git.example.test/repo.git', secrets: ['tok3nValue', 'git:'] },
  // Key-like words judged whole.
  { name: 'a UUID file', command: `cat ${UUID_KEY}.json`, secrets: [UUID_KEY, '446655440000'] },
  { name: 'a UUID path segment', command: `cat keys/${UUID_KEY}/a.txt`, secrets: [UUID_KEY, '446655440000'] },
  { name: 'a UUID with few digits', command: 'cat runs/ffffffff-ffff-4fff-bfff-ffffffffffff.json', secrets: ['ffffffff-ffff'] },
  { name: 'a slash-segmented key', command: `cat ${AWS_SECRET}`, secrets: ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfi'] },
  { name: 'a dot-segmented key', command: 'cat Xk9q.Pq2w.Zr7e.json', secrets: ['Xk9q', 'Pq2w', 'Zr7e'] },
  { name: 'a plus-segmented key', command: 'cat a1b2+c3d4+e5f6.txt', secrets: ['a1b2', 'c3d4', 'e5f6'] },
  { name: 'a base64 secret', command: `echo ${BASE64_SECRET} | base64 -d`, secrets: [BASE64_SECRET.slice(0, 12)] },
  { name: 'a base64 secret as a path', command: 'cat c3VwZXI/c2VjcmV0/dmFsdWU.txt', secrets: ['c3VwZXI', 'c2VjcmV0'] },
  { name: 'a short token naming a file', command: 'cat tokens/x7Kp2mQ9.txt', secrets: ['x7Kp2mQ9'] },
  // Access keys.
  { name: 'AWS keys in leading assignments', command: `AWS_ACCESS_KEY_ID=${AWS_KEY_ID} AWS_SECRET_ACCESS_KEY=${AWS_SECRET} aws s3 ls`, secrets: [AWS_KEY_ID, 'wJalrXUtnFEMI', 'AWS_SECRET_ACCESS_KEY'] },
  { name: 'an AWS access key id as an argument', command: `aws configure set aws_access_key_id ${AWS_KEY_ID}`, secrets: [AWS_KEY_ID] },
  { name: 'a Stripe live key exported', command: `export STRIPE=${STRIPE_LIVE}`, secrets: ['rk_live', '51HxQw'] },
  { name: 'an OpenAI key in env', command: `env OPENAI_API_KEY=${OPENAI_KEY} node app.js`, secrets: ['sk-', 'Zx81Qw'] },
  { name: 'a token assigned before a command', command: 'TOKEN=x9secret npm publish', secrets: ['x9secret', 'TOKEN'] },
  { name: 'a GitHub token as an argument', command: `gh auth login --with-token ${GITHUB_PAT}`, secrets: ['ghp_', 'R4nd0m'] },
  { name: 'a Slack bot token', command: `slack-cli send --token ${SLACK_BOT} hello`, secrets: ['xoxb', 'AbCdEf'] },
  { name: 'a bare JWT', command: `echo ${BARE_JWT}`, secrets: ['eyJhbGci', 'dozjgNryP4'] },
  { name: 'a JWT in a header', command: `curl -H "Authorization: Bearer ${BARE_JWT}" https://example.test`, secrets: ['eyJhbGci', 'Bearer'] },
  { name: 'a JWT in a glued header', command: `curl -HAuthorization:Bearer:${BARE_JWT} https://example.test`, secrets: ['eyJhbGci', 'Bearer'] },
  { name: 'an API key header', command: 'curl -H "X-Api-Key: k3yValue99" https://example.test', secrets: ['k3yValue99', 'X-Api-Key'] },
  { name: 'an unquoted API key header', command: 'curl -H X-Api-Key:k3yValue99 https://example.test', secrets: ['k3yValue99'] },
  { name: 'curl basic credentials', command: 'curl -u admin:Pa55word https://api.example.test', secrets: ['Pa55word', 'admin'] },
  // Passwords given to clients.
  { name: 'a MySQL password glued to its flag', command: 'mysql -uroot -pPa55word app', secrets: ['Pa55word', 'root'] },
  { name: 'a MySQL password after -p', command: 'mysql -u root -p Pa55word app', secrets: ['Pa55word', 'root'] },
  { name: 'a password after its long flag', command: 'mysql --password Pa55word app', secrets: ['Pa55word'] },
  { name: 'a password in its long flag', command: 'mysql --password=Pa55word app', secrets: ['Pa55word'] },
  { name: 'a Redis password', command: 'redis-cli -a Pa55word ping', secrets: ['Pa55word'] },
  { name: 'a docker login', command: 'docker login -u deployer -p Pa55word registry.example.test', secrets: ['Pa55word', 'deployer'] },
  { name: 'an sshpass password', command: 'sshpass -p Pa55word ssh deploy@host.example.test', secrets: ['Pa55word', 'deploy@'] },
  { name: 'an inline Python key', command: `python -c "import openai; openai.api_key='${OPENAI_KEY}'"`, secrets: ['sk-', 'Zx81Qw', 'openai'] },
  { name: 'a shell script carrying a key', command: `bash -lc "curl -H 'Authorization: Bearer ${BARE_JWT}' https://example.test"`, secrets: ['eyJhbGci', 'Bearer'] },
  { name: 'a shell script echoing a word', command: "sh -c 'echo hunter22'", secrets: ['hunter22'] },
  // Found by the second probe.
  { name: 'a value after a secret-named flag that looks like a file', command: 'login --password Winter.Is.Coming', secrets: ['Winter', 'Coming'] },
  { name: 'a path after a token flag', command: 'deploy --token ./tok3n-file', secrets: ['tok3n-file'] },
  { name: 'a path after a single-dash pass flag', command: 'openssl rsa -passin ./hunter-pass.txt -in key.pem', secrets: ['hunter-pass'] },
  { name: 'a dotted word that is no file', command: 'unlock Winter.Is.Coming', secrets: ['Winter', 'Coming'] },
  { name: 'a negation before a word', command: 'test ! hunter2', secrets: ['hunter2'] },
  { name: 'a group opener before a word', command: 'echo ( hunter2', secrets: ['hunter2'] },
  { name: 'a bracket test', command: '[ ! hunter2 ]', secrets: ['hunter2'] },
  { name: 'a brace before a word', command: 'echo { hunter2 }', secrets: ['hunter2'] },
  { name: 'an unknown word as a shell script', command: "bash -c 'vllkbsi5'", secrets: ['vllkbsi5'] },
  { name: 'an unknown word after an operator', command: 'true && Summer2024', secrets: ['Summer2024'] },
  { name: 'an unknown word after a pipe', command: 'echo x | hunterpass', secrets: ['hunterpass'] },
  { name: 'a lowercase word a subcommand program does not list', command: 'git hunterpass', secrets: ['hunterpass'] },
  { name: 'a lowercase word after the end of flags', command: 'npm -- hunterpass', secrets: ['hunterpass'] },
  { name: 'an entropic tunnel host', command: 'curl https://k7x9q2mzp4.trycloudflare.com/x', secrets: ['k7x9q2mzp4'] },
  { name: 'an entropic preview host', command: 'curl https://a8f3e1b2c9d4.ngrok.app', secrets: ['a8f3e1b2c9d4'] },
];

/**
 * Free text a harness names as a search pattern, a search or fetch query, or an agent-protocol call's title. A command
 * keeps its program's name, so free text is judged on the paths that read it as a query or a title.
 */
export const FREE_TEXT: readonly Leak[] = [
  { name: 'a search query', command: 'letmein77 rotation', secrets: ['letmein77', 'rotation'] },
  { name: 'a search for a key', command: `where is ${AWS_KEY_ID} used`, secrets: [AWS_KEY_ID] },
  { name: 'a grep pattern', command: 'hunter22', secrets: ['hunter22'] },
];

/** Key-shaped values whose provider prefix alone says they are keys: short, or all letters, so no other shape catches them. */
export const STRIPE_SHORT = ['sk', 'live', 'abcdefghijkl'].join('_');
export const SLACK_USER = ['xoxp', 'abcdefghij'].join('-');
export const GITLAB_SHORT = ['glpat', 'abcdefghijkl'].join('-');
export const GITHUB_SHORT = ['ghp', 'abcdefghijklmnop'].join('_');
export const GITHUB_FINE = ['github', 'pat', 'abcdefghijklmnop'].join('_');
export const GOOGLE_KEY = ['AIza', 'SyAbcdefghijklmnop'].join('');
export const OPENAI_LETTERS = ['sk', 'abcdefghijklmnop'].join('-');

/**
 * Prose an agent writes around a secret: a labeled value over several words, in quotes or a table; a label of any
 * secret's name; a key known only by its provider's prefix; a key echoed with its middle masked; a credential pair;
 * a password-file record; and a key or a label broken by zero-width characters. Agent prose keeps none of them.
 */
export const PROSE: readonly Leak[] = [
  ...['1 customer-content', '12000; customer-content'].map((value) => ({ name: `token quantity payload ${value}`, command: `Read the policy.\ntoken_budget: ${value}\nUpdated the policy.`, secrets: ['customer-content'] })),
  { name: 'text in a token quantity', command: 'Read the policy.\ntoken_budget: "customer-fragment" Updated the policy.', secrets: ['customer-fragment'] },
  ...['DBPASSWORD', 'ACCESSTOKEN', 'CLIENTAPIKEY'].map((label) => ({ name: `uppercase ${label}`, command: `Read the policy.\n${label}: "hunter22" Updated the policy.`, secrets: ['hunter22'] })),
  ...['\n', '\r\n'].map((newline) => ({ name: `a quoted secret across ${newline === '\n' ? 'LF' : 'CRLF'}`, command: `Read the policy.\nclientPassword: "customer-fragment${newline}piano-harbor"\nUpdated the policy.`, secrets: ['customer-fragment', 'piano-harbor'] })),
  { name: 'a compatibility Unicode secret label', command: 'Read the policy.\nclientＰassword: piano-harbor\nUpdated the policy.', secrets: ['piano-harbor'] },
  { name: 'a compatibility Unicode label delimiter', command: 'Read the policy.\nclientPassword： piano-harbor\nUpdated the policy.', secrets: ['piano-harbor'] },
  { name: 'a fullwidth secret label', command: 'Read the policy.\nｃｌｉｅｎｔＰａｓｓｗｏｒｄ： piano-harbor\nUpdated the policy.', secrets: ['piano-harbor'] },
  ...['accessKey', 'access_key', 'access-key'].map((label) => ({ name: `an ${label} label`, command: `Read the policy.\n${label}: piano-harbor\nUpdated the policy.`, secrets: ['piano-harbor'] })),
  { name: 'an escaped quote inside a multiline secret', command: 'Read the policy.\nclientPassword: "customer-fragment\\"\npiano-harbor"\nUpdated the policy.', secrets: ['customer-fragment', 'piano-harbor'] },
  { name: 'indented JSON output', command: 'Read the configuration:\n\n    {"clientPassword":"piano-harbor","note":"customer-content"}\n\nUpdated the policy.', secrets: ['piano-harbor', 'customer-content'] },
  { name: 'tab-indented YAML output', command: 'Read the configuration:\n\tclientPassword: piano-harbor\n\tnote: customer-content\nUpdated the policy.', secrets: ['piano-harbor', 'customer-content'] },
  { name: 'blockquote output', command: 'Read the response:\n> customer-content\n> another copied line\nUpdated the policy.', secrets: ['customer-content', 'another copied line'] },
  { name: 'a camelCase password label', command: 'clientPassword: piano-harbor', secrets: ['piano-harbor'] },
  { name: 'a camelCase token label', command: 'serviceAccessToken is piano-harbor', secrets: ['piano-harbor'] },
  { name: 'a camelCase API key label', command: 'clientApiKey: piano-harbor', secrets: ['piano-harbor'] },
  { name: 'an empty JSON key', command: 'Observed {"":"customer-content"} and updated the policy.', secrets: ['customer-content'] },
  { name: 'an escaped JSON key', command: `Observed ${JSON.stringify({ 'escaped"key': 'customer-content' })} and updated the policy.`, secrets: ['customer-content'] },
  { name: 'nested structured JSON output', command: 'Observed {"note":"customer-content","nested":{"mode":"private-mode"}} and updated the policy.', secrets: ['customer-content', 'private-mode'] },
  { name: 'a primitive-first JSON array', command: 'Observed [0,"customer-content"] and updated the policy.', secrets: ['customer-content'] },
  { name: 'a boolean-first JSON array', command: 'Observed [true,"customer-content"] and updated the policy.', secrets: ['customer-content'] },
  { name: 'structured array output', command: 'Observed ["customer-content", {"mode":"private-mode"}] and updated the policy.', secrets: ['customer-content', 'private-mode'] },
  { name: 'unclosed structured output', command: 'Observed {"note":"customer-content", "nested": {"mode":"private-mode"', secrets: ['customer-content', 'private-mode'] },
  { name: 'unfenced structured JSON output', command: 'Observed {"note":"customer-content","mode":"private-mode"} and updated the policy.', secrets: ['customer-content', 'private-mode'] },
  { name: 'a quoted secret of several words', command: 'The secret is "alpha beta gamma" for now.', secrets: ['alpha', 'beta', 'gamma'] },
  { name: 'a passphrase of several words', command: 'passphrase: my dog spot', secrets: ['my dog spot', 'dog', 'spot'] },
  { name: 'a password in a table cell', command: '| name | value |\n| DB_PASSWORD | p@ss w0rd |\n| HOST | db |', secrets: ['p@ss', 'w0rd'] },
  { name: 'a pw label', command: 'pw: hunter22', secrets: ['hunter22'] },
  { name: 'a pwd label', command: 'set pwd = hunter22 then', secrets: ['hunter22'] },
  { name: 'a pass label', command: 'pass: hunter22 for the vault', secrets: ['hunter22'] },
  { name: 'a pin', command: 'the pin is 4417', secrets: ['4417'] },
  { name: 'a passcode', command: 'passcode: 991122', secrets: ['991122'] },
  { name: 'a credential pair after a slash', command: 'creds: admin / hunter22', secrets: ['admin', 'hunter22'] },
  { name: 'a credential pair after a colon', command: 'credentials: admin:hunter22', secrets: ['admin', 'hunter22'] },
  { name: 'a Stripe key by its prefix', command: `uses ${STRIPE_SHORT} in test`, secrets: [STRIPE_SHORT] },
  { name: 'a Slack token by its prefix', command: `posted with ${SLACK_USER}`, secrets: [SLACK_USER] },
  { name: 'a GitLab token by its prefix', command: `cloned with ${GITLAB_SHORT}`, secrets: [GITLAB_SHORT] },
  { name: 'a GitHub token by its prefix', command: `pushed with ${GITHUB_SHORT}`, secrets: [GITHUB_SHORT] },
  { name: 'a fine-grained GitHub token by its prefix', command: `pushed with ${GITHUB_FINE}`, secrets: [GITHUB_FINE] },
  { name: 'a Google key by its prefix', command: `called with ${GOOGLE_KEY}`, secrets: [GOOGLE_KEY] },
  { name: 'an OpenAI key of letters', command: `called with ${OPENAI_LETTERS}`, secrets: [OPENAI_LETTERS] },
  { name: 'a key echoed with its middle masked', command: 'the key sk-proj-abc****wxyz worked', secrets: ['abc****', '****wxyz'] },
  { name: 'a value echoed with its middle masked and no prefix', command: 'the log printed AbCd****WxYz back', secrets: ['AbCd', 'WxYz'] },
  { name: 'a passwd record', command: 'found it:\nroot:x:0:0:root:/root:/bin/bash\nin the image', secrets: ['root:x:0', '/bin/bash'] },
  { name: 'a shadow line', command: 'deploy:$6$saltsalt$hashhashhash:19000:0:99999:7:::', secrets: ['saltsalt', 'hashhash'] },
  { name: 'a label broken by a zero-width space', command: 'pass​word: hunter22', secrets: ['hunter22'] },
  { name: 'a key broken by a zero-width joiner', command: `the key was ${OPENAI_KEY.slice(0, 10)}‍${OPENAI_KEY.slice(10)}`, secrets: [OPENAI_KEY.slice(10), OPENAI_KEY.slice(0, 10)] },
];

/** Arbitrary diagnostic payloads, including ordinary content with no key-like shape. */
export const DIAGNOSTIC_PAYLOADS: readonly Leak[] = [
  { name: 'a diagnostic sentence impersonation', command: 'the worker could not start the run (no_driver: customer_note)', secrets: ['customer_note'] },
  { name: 'a whitespace-prefixed quota echo', command: `${' '.repeat(200)}AiError: 4006 daily free allocation; customer-content piano-harbor`, secrets: ['customer-content', 'piano-harbor'] },
  { name: 'a whitespace-prefixed input echo', command: `${' '.repeat(200)}AiError: 3010 invalid or incomplete input; customer-content piano-harbor`, secrets: ['customer-content', 'piano-harbor'] },
  { name: 'a file excerpt', command: 'customer-content from the confidential document', secrets: ['customer-content', 'confidential document'] },
  { name: 'a provider echo', command: 'password=piano-harbor; input=customer-content', secrets: ['piano-harbor', 'customer-content'] },
  { name: 'a provider JSON body', command: '{"clientPassword":"piano-harbor","input":"customer-content"}', secrets: ['piano-harbor', 'customer-content'] },
  { name: 'a provider quota echo', command: 'AiError: 4006 daily free allocation; customer-content piano-harbor', secrets: ['customer-content', 'piano-harbor'] },
  { name: 'a provider input echo', command: 'AiError: 3010 invalid or incomplete input; customer-content piano-harbor', secrets: ['customer-content', 'piano-harbor'] },
];
