/** Wrangler's default module rules load `*.bin` as a Data module: the file's bytes. */
declare module '*.bin' {
  const data: ArrayBuffer;
  export default data;
}
