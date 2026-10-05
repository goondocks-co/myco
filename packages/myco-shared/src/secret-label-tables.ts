/** Names matched against payload labels, never display copy. */
export const SECRET_COMPONENT_TABLE: readonly string[] = [
  'password', 'passwd', 'passphrase', 'passcode', 'pass', 'pwd', 'pw', 'pin', 'secret', 'token',
  'credential', 'credentials', 'creds', 'key', 'apikey', 'accesskey', 'auth', 'authorization', 'bearer',
];

export const UPPER_SECRET_SUFFIXES: readonly string[] = ['PASSWORD', 'PASSWD', 'PASSPHRASE', 'PASSCODE', 'TOKEN', 'SECRET', 'CREDENTIAL', 'CREDENTIALS', 'APIKEY', 'ACCESSKEY', 'AUTHORIZATION'];

export const TOKEN_QUANTITY_TABLE: readonly string[] = ['tokenbudget', 'tokenlimit', 'tokencount', 'tokensbudget', 'tokenslimit', 'tokenscount'];
