/**
 * Replace `{{name}}` placeholders in a template with values from `vars`.
 *
 * Missing keys are left in place — callers who need strict substitution
 * should validate their inputs before calling. Used by prompt composition
 * (task + phase prompts) and template-file loading.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
