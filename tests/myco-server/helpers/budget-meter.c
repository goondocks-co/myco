#include <stdio.h>
#include <stdlib.h>
#include "sqlite3.h"

int main(int argc, char **argv) {
  sqlite3 *db = NULL;
  sqlite3_stmt *stmt = NULL;
  if (argc != 3 || sqlite3_open(argv[1], &db) != SQLITE_OK) return 2;
  sqlite3_exec(db, "PRAGMA foreign_keys=ON", NULL, NULL, NULL);
  if (sqlite3_prepare_v2(db, argv[2], -1, &stmt, NULL) != SQLITE_OK) {
    fprintf(stderr, "%s\n", sqlite3_errmsg(db)); return 3;
  }
  int status;
  while ((status = sqlite3_step(stmt)) == SQLITE_ROW) {}
  if (status != SQLITE_DONE) { fprintf(stderr, "%s\n", sqlite3_errmsg(db)); return 4; }
  sqlite3_int64 visits = 0;
  for (int loop = 0;; loop++) {
    sqlite3_int64 count;
    const char *name = NULL;
    if (sqlite3_stmt_scanstatus_v2(stmt, loop, SQLITE_SCANSTAT_NVISIT, 0, &count)) break;
    sqlite3_stmt_scanstatus_v2(stmt, loop, SQLITE_SCANSTAT_NAME, 0, &name);
    if (name != NULL) visits += count;
  }
  printf("%lld\n", (long long)visits);
  sqlite3_finalize(stmt);
  sqlite3_close(db);
  return 0;
}
