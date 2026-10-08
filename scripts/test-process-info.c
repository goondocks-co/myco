#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <stdlib.h>
#include <unistd.h>

/* Read process counters without a privileged executable. */
int main(int argc, char **argv) {
  if (argc < 2 || argc > 3) return 1;
  if (strcmp(argv[1], "list") == 0) {
    const int PID_LIST_GROWTH_MARGIN = 64;
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (bytes <= 0) { perror("proc_listpids"); return 1; }
    int capacity = bytes + PID_LIST_GROWTH_MARGIN * sizeof(pid_t);
    pid_t *pids = NULL;
    int complete = 0;
    const int MAX_PID_LIST_ATTEMPTS = 5;
    for (int attempt = 0; attempt < MAX_PID_LIST_ATTEMPTS; attempt++) {
      free(pids);
      pids = malloc(capacity);
      if (!pids) return 1;
      bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, capacity);
      if (bytes < capacity) { complete = 1; break; }
      capacity *= 2;
    }
    if (bytes <= 0) { free(pids); perror("proc_listpids"); return 1; }
    if (!complete) {
      free(pids);
      fputs("proc_listpids did not settle\n", stderr);
      return 1;
    }
    for (int index = 0; index < bytes / sizeof(pid_t); index++) {
      if (pids[index] <= 0) continue;
      struct proc_bsdinfo state;
      if (proc_pidinfo(pids[index], PROC_PIDTBSDINFO, 0, &state, sizeof(state)) != sizeof(state)) continue;
      printf("%d %u %u %llu.%06llu\n", pids[index], state.pbi_ppid, state.pbi_pgid,
        (unsigned long long)state.pbi_start_tvsec, (unsigned long long)state.pbi_start_tvusec);
    }
    free(pids);
    return 0;
  }
  const pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
  if (argc == 3 && strcmp(argv[2], "command") == 0) {
    const size_t ARGUMENT_BYTES_LIMIT = 1024 * 1024;
    int name[] = { CTL_KERN, KERN_PROCARGS2, pid };
    size_t bytes = ARGUMENT_BYTES_LIMIT;
    char *buffer = malloc(bytes);
    if (!buffer) return 1;
    if (sysctl(name, 3, buffer, &bytes, NULL, 0) < 0) {
      free(buffer);
      if (errno == ESRCH) return 0;
      perror("sysctl process arguments"); return 1;
    }
    if (bytes < sizeof(int)) { free(buffer); return 1; }
    int count;
    memcpy(&count, buffer, sizeof(count));
    char *current = buffer + sizeof(int), *end = buffer + bytes;
    while (current < end && *current) current++;
    while (current < end && !*current) current++;
    printf("%d", pid);
    for (int index = 0; index < count && current < end; index++) {
      putchar(' ');
      while (current < end && *current) putchar(*current++);
      if (current < end) current++;
    }
    putchar('\n'); free(buffer); return 0;
  }
  if (argc == 3 && (strcmp(argv[2], "state") == 0 || strcmp(argv[2], "pgid") == 0)) {
    struct proc_bsdinfo state;
    int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &state, sizeof(state));
    if (size != sizeof(state)) {
      if (errno == ESRCH) { puts(""); return 0; }
      perror("proc_pidinfo");
      return 1;
    }
    if (strcmp(argv[2], "pgid") == 0) printf("%u\n", state.pbi_pgid);
    else puts(state.pbi_status == SZOMB ? "Z" : "R");
    return 0;
  }
  struct proc_taskinfo info;
  int size = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &info, sizeof(info));
  if (size != sizeof(info)) {
    if (errno == ESRCH) { puts("0"); return 0; }
    perror("proc_pidinfo");
    return 1;
  }
  printf("%llu\n", (unsigned long long)info.pti_resident_size / 1024);
  return 0;
}
