#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "version") == 0 &&
      strcmp(argv[2], "--json") == 0) {
    usleep(400000);
    puts("{\"version\":\"fixture\",\"build\":\"static\"}");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    puts("fake grok root help");
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "agent") == 0 &&
      strcmp(argv[2], "--help") == 0) {
    puts("fake grok agent help");
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "agent") == 0 &&
      strcmp(argv[2], "stdio") == 0 && strcmp(argv[3], "--help") == 0) {
    puts("fake grok agent stdio help");
    return 0;
  }
  fputs("unexpected static probe command\n", stderr);
  return 64;
}
