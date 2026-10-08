#include <sys/types.h>
#include <unistd.h>

extern int sandbox_check(pid_t pid, const char *operation, int filter, ...);

/* A child retains every execution denial its parent already owns. */
int main(int argc, char **argv) {
  for (int index = 1; index < argc; index++) {
    if (sandbox_check(getpid(), "process-exec", 1, argv[index]) != 1) return 1;
  }
  return 0;
}
