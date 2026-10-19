// macOS-only benchmark helper. Never overwrite the input or an existing output.
// Write a private copy without populating its data-page cache, then verify every
// page with mincore. Print counts only. Exit 11 if any page remains resident.
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int in = open(argv[1], O_RDONLY);
  int out = open(argv[2], O_CREAT | O_EXCL | O_RDWR, 0600);
  if (in < 0 || out < 0 || fcntl(out, F_NOCACHE, 1) < 0) return 3;
  void *buffer;
  if (posix_memalign(&buffer, 4096, 1048576)) return 4;
  ssize_t length;
  while ((length = read(in, buffer, 1048576)) > 0) {
    ssize_t offset = 0;
    while (offset < length) {
      ssize_t written = write(out, (char *)buffer + offset, length - offset);
      if (written < 1) return 5;
      offset += written;
    }
  }
  if (length < 0 || fsync(out)) return 6;
  struct stat info;
  if (fstat(out, &info) || info.st_size == 0) return 7;
  close(in);
  close(out);
  free(buffer);

  int fd = open(argv[2], O_RDONLY);
  if (fd < 0) return 8;
  long page = sysconf(_SC_PAGESIZE);
  size_t pages = (info.st_size + page - 1) / page;
  void *mapping = mmap(NULL, info.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (mapping == MAP_FAILED) return 9;
  char *states = calloc(pages, 1);
  if (!states || mincore(mapping, info.st_size, states)) return 10;
  size_t resident = 0;
  for (size_t i = 0; i < pages; i++) {
    if (states[i] & MINCORE_INCORE) resident++;
  }
  printf("{\"pages\":%zu,\"residentPages\":%zu}\n", pages, resident);
  free(states);
  munmap(mapping, info.st_size);
  close(fd);
  return resident ? 11 : 0;
}
