import { type DeploymentRecord, writeDeploymentRecord } from './cloudflare.js';
import { stageCloudflareDeploy } from './cloudflare-stage.js';
import { cpuLimitRefusedForThisRelease } from './deploy-config.js';
import { cloudflareErrorCodes } from './object-read.js';
import { withCloudflareOperation } from './cloudflare-operation.js';
import { getPluginVersion } from '../version.js';

interface UploadOptions {
  mycoHome?: string;
  cpuLimit?: boolean;
  report?: (line: string) => void;
  /** Recovery keeps facts in its journal until publication. */
  persist?: (record: DeploymentRecord) => void | Promise<void>;
}

const CPU_LIMIT_UNSUPPORTED_CODE = '100328';
const CPU_LIMIT_NOTICE = 'Cloudflare refused a custom CPU limit. Retrying without it. Workers Free allows 10 ms of CPU per invocation (requests and scheduled ticks); heavy work such as transcript import or large reads may be cut short. Workers Paid removes that 10 ms restriction. https://developers.cloudflare.com/workers/platform/limits/#cpu-time';
const CPU_LIMIT_REPEAT_NOTICE = 'Cloudflare still refuses the custom CPU limit; retrying without it.';

/** One operation's uploads share a single explicit CPU-limit probe. */
export class CloudflareUploads {
  private cpuLimit;
  private readonly persist;

  constructor(private readonly options: UploadOptions) {
    this.options = { ...options };
    this.cpuLimit = this.options.cpuLimit === true;
    this.persist = this.options.persist ?? (record => writeDeploymentRecord(record, this.options.mycoHome));
  }

  async upload<T>(record: DeploymentRecord, upload: () => Promise<T>): Promise<{ record: DeploymentRecord; result: T }> {
    return withCloudflareOperation(this.options.mycoHome, async () => {
      const explicit = this.cpuLimit;
      this.cpuLimit = false;
      const candidate = explicit ? { ...record, cpuLimitRefusedRelease: undefined } : record;
      if (explicit) stageCloudflareDeploy(candidate, this.options.mycoHome);
      let result: T;
      try {
        result = await upload();
      } catch (error) {
        if ((!explicit && cpuLimitRefusedForThisRelease(record)) || !cloudflareErrorCodes(error).includes(CPU_LIMIT_UNSUPPORTED_CODE)) throw error;
        const repeated = record.cpuLimitRefusedRelease !== undefined;
        record = { ...record, cpuLimitRefusedRelease: getPluginVersion() };
        await this.persist(record);
        stageCloudflareDeploy(record, this.options.mycoHome);
        this.options.report?.(repeated ? CPU_LIMIT_REPEAT_NOTICE : CPU_LIMIT_NOTICE);
        return { record, result: await upload() };
      }
      if (explicit) await this.persist(candidate);
      return { record: candidate, result };
    });
  }
}
