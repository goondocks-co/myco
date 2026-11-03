/** Source changes and safety scans queue existing receipts under a revision guarded by the consumer. */
export function queueRetirementSql(where: string): string {
  return `INSERT INTO embedding_retirement_queue(project_id,model_key,id,revision)
    SELECT project_id,model_key,id,1 FROM embedding_receipts WHERE ${where}
    ON CONFLICT(project_id,model_key,id) DO UPDATE SET revision=revision+1;`;
}
