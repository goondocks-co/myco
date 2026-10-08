#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Descendant execution is confined to the test fixtures and admitted tooling. */
static int allow_path(int rules, const char *path, __u64 access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return -1;
  struct landlock_path_beneath_attr entry = { .allowed_access = access, .parent_fd = fd };
  int result = syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &entry, 0);
  close(fd);
  return result;
}

int main(int argc, char **argv) {
  struct landlock_ruleset_attr policy = { .handled_access_fs = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_REFER };
  int rules = syscall(SYS_landlock_create_ruleset, &policy, sizeof(policy), 0);
  if (rules < 0) goto refused;
  if (allow_path(rules, "/", LANDLOCK_ACCESS_FS_REFER) < 0) goto refused;
  int index = 1;
  for (; index + 1 < argc && strcmp(argv[index], "--allow") == 0; index += 2) {
    if (allow_path(rules, argv[index + 1], LANDLOCK_ACCESS_FS_EXECUTE) < 0) goto refused;
  }
  if (index >= argc || strcmp(argv[index], "--") != 0 || index + 1 >= argc) goto refused;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || syscall(SYS_landlock_restrict_self, rules, 0)) goto refused;
  close(rules);
  execvp(argv[index + 1], &argv[index + 1]);
refused:
  fprintf(stderr, "TEST SAFETY: service-exec sandbox refused execution: %s\n", strerror(errno));
  return 97;
}
