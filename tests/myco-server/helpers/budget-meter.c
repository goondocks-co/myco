#include <stdio.h>
#include <stdlib.h>
#include "sqlite3.h"

int main(int argc, char **argv) {
  sqlite3 *db = NULL;
  sqlite3_stmt *stmt = NULL;
  if (argc != 3 || sqlite3_open(argv[1], &db) != SQLITE_OK) return 2;
  FILE *input = fopen(argv[2], "rb");
  if (input == NULL || fseek(input, 0, SEEK_END) != 0) return 2;
  long length = ftell(input);
  if (length < 0 || fseek(input, 0, SEEK_SET) != 0) return 2;
  char *sql = malloc((size_t)length + 1);
  if (sql == NULL || fread(sql, 1, (size_t)length, input) != (size_t)length) return 2;
  fclose(input);
  sql[length] = '\0';
  sqlite3_exec(db, "PRAGMA foreign_keys=ON", NULL, NULL, NULL);
  sqlite3_int64 visits = 0;
  const char *remaining = sql;
  while (*remaining) {
    if (sqlite3_prepare_v2(db, remaining, -1, &stmt, &remaining) != SQLITE_OK) {
      fprintf(stderr, "%s\n", sqlite3_errmsg(db)); return 3;
    }
    if (stmt == NULL) continue;
    int status;
    while ((status = sqlite3_step(stmt)) == SQLITE_ROW) {}
    if (status != SQLITE_DONE) { fprintf(stderr, "%s\n", sqlite3_errmsg(db)); return 4; }
    for (int loop = 0;; loop++) {
      sqlite3_int64 count;
      const char *name = NULL;
      if (sqlite3_stmt_scanstatus_v2(stmt, loop, SQLITE_SCANSTAT_NVISIT, 0, &count)) break;
      sqlite3_stmt_scanstatus_v2(stmt, loop, SQLITE_SCANSTAT_NAME, 0, &name);
      if (name != NULL) visits += count;
    }
    sqlite3_finalize(stmt);
  }
  printf("%lld\n", (long long)visits);
  free(sql);
  sqlite3_close(db);
  return 0;
}
