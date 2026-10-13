/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const WORKFLOW_PATH = path.resolve('.github/workflows/ci.yml');
const HELPER_PATH = path.resolve('tests/helpers/windows-native-contract.ts');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
}

interface WorkflowJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

describe('Windows native CI contract', () => {
  test('defines the required bounded Windows job and exact cleanup boundary', () => {
    const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const job = workflow.jobs?.['windows-native'];

    expect(job).toBeDefined();
    if (!job) return;
    expect(job['runs-on']).toBe('windows-latest');
    expect(job['timeout-minutes']).toBe(15);
    expect(job.env).not.toHaveProperty('MYCO_LAUNCH_AGENTS_DIR');
    expect(job.env).not.toHaveProperty('MYCO_WINDOWS_NATIVE_SCRATCH');
    expect(job.env).not.toHaveProperty('MYCO_WINDOWS_NATIVE_EXE');

    const pathSetup = job.steps?.find(
      (step) => step.name === 'Configure Windows native contract paths',
    );
    expect(pathSetup?.run).toContain('$env:RUNNER_TEMP');
    expect(pathSetup?.run).toContain('$env:GITHUB_ENV');
    expect(pathSetup?.run).toContain("'Myco Native Contract.exe'");
    expect(pathSetup?.run).not.toContain("'Myco Native Ω Contract.exe'");

    const uses = job.steps?.flatMap((step) => step.uses ? [step.uses] : []) ?? [];
    expect(uses).toEqual(expect.arrayContaining([
      'actions/checkout@v7',
      'actions/setup-node@v7',
      'oven-sh/setup-bun@v2',
    ]));

    const commands = job.steps?.flatMap((step) => step.run ? [step.run] : []) ?? [];
    const commandText = commands.join('\n');
    expect(commandText).toContain('npm ci');
    expect(commandText).toContain('tests/service/windows-native-ci-contract.test.ts');
    // A command's deadline ends its process tree by a mechanism that is entirely different here — `taskkill`
    // rather than a process group — so the portable deadline test has to actually run on Windows. Nothing else
    // in the suite exercises that branch, and nothing but this list can make Windows run it.
    expect(commandText).toContain('tests/server/runner.test.ts');
    expect(commandText).toContain('bun build --compile --target=bun-windows-x64');
    expect(commandText).toContain('tests/helpers/windows-native-contract.ts');

    const cleanup = job.steps?.find((step) => step.if === 'always()');
    expect(cleanup?.run).toContain('$env:MYCO_WINDOWS_NATIVE_TASK_LABEL');
    expect(cleanup?.run).toContain('$env:MYCO_WINDOWS_NATIVE_SCRATCH');
    expect(cleanup?.run).toContain('$env:MYCO_WINDOWS_NATIVE_EXE');
    expect(cleanup?.run).toContain("Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop");
    expect(cleanup?.run).toContain('could not verify exact task cleanup');
    expect(cleanup?.run).toContain('Get-CimInstance -ClassName Win32_Process -ErrorAction Stop');
    expect(cleanup?.run).toContain(
      '[StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $contractExecutable)',
    );
    expect(cleanup?.run).toContain('Stop-Process -Id $contractProcess.ProcessId -Force -ErrorAction Stop');
    expect(cleanup?.run).toContain('Contract child processes remained');
    expect(cleanup?.run).toContain('Test-Path -LiteralPath $env:MYCO_WINDOWS_NATIVE_SCRATCH');
    expect(cleanup?.run).toContain('Test-Path -LiteralPath $env:MYCO_WINDOWS_NATIVE_EXE');
    expect(cleanup?.run).toContain('$global:LASTEXITCODE = 0');
    expect(cleanup?.run).not.toContain('exit 0');
  });

  test('helper scopes native filesystem and lifecycle proofs to the CI scratch directory', async () => {
    expect(fs.existsSync(HELPER_PATH)).toBe(true);
    if (!fs.existsSync(HELPER_PATH)) return;

    const {
      assertWindowsNativeContractScope,
    } = await import('../helpers/windows-native-contract.js');

    const runnerTemp = 'C:\\Runner Temp';
    const executable = `${runnerTemp}\\Myco Native Ω Contract.exe`;
    const scratch = `${runnerTemp}\\Myco Native Ω 123-1`;
    const label = 'Myco-CI-Native-123-1';

    expect(() => assertWindowsNativeContractScope({
      runnerTemp,
      executable,
      scratch,
      taskLabel: label,
    })).not.toThrow();
    expect(() => assertWindowsNativeContractScope({
      runnerTemp,
      executable: 'D:\\outside.exe',
      scratch,
      taskLabel: label,
    })).toThrow(/RUNNER_TEMP/);
    expect(() => assertWindowsNativeContractScope({
      runnerTemp,
      executable,
      scratch: runnerTemp,
      taskLabel: label,
    })).toThrow(/scratch/);
    expect(() => assertWindowsNativeContractScope({
      runnerTemp,
      executable,
      scratch,
      taskLabel: 'unscoped-task',
    })).toThrow(/task label/);


  });

  test('helper retries transient Windows scratch cleanup failures within a bound', () => {
    const helper = fs.readFileSync(HELPER_PATH, 'utf8');

    expect(helper).toContain("new Set(['EBUSY', 'ENOTEMPTY', 'EPERM'])");
    expect(helper).toContain('const CLEANUP_TIMEOUT_MS = 10_000');
    expect(helper).toContain('await removeScratchDirectory(scratch)');
    expect(helper).toContain('Date.now() >= deadline');
  });
});
