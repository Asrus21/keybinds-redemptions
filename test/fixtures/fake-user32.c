// user32 de mentira para testar a chamada da SendInput fora do Windows.
// Os structs copiam o layout do winuser.h com tipos de tamanho fixo, que é
// igual no Windows x64 e no Linux x64.
#include <stdint.h>
#include <string.h>

typedef struct { int32_t dx, dy; uint32_t mouseData, dwFlags, time; uintptr_t dwExtraInfo; } MOUSEINPUT;
typedef struct { uint16_t wVk, wScan; uint32_t dwFlags, time; uintptr_t dwExtraInfo; } KEYBDINPUT;
typedef struct { uint32_t uMsg; uint16_t wParamL, wParamH; } HARDWAREINPUT;
typedef struct { uint32_t type; union { MOUSEINPUT mi; KEYBDINPUT ki; HARDWAREINPUT hi; } u; } INPUT;

#define MAX_REC 256
static struct { uint32_t type; KEYBDINPUT ki; } rec[MAX_REC];
static int count = 0;
static int last_cb = 0;
static int fail = 0;

unsigned int SendInput(unsigned int n, INPUT *in, int cb) {
  last_cb = cb;
  if (fail) return 0;
  for (unsigned int i = 0; i < n && count < MAX_REC; i++) {
    rec[count].type = in[i].type;
    rec[count].ki = in[i].u.ki;
    count++;
  }
  return n;
}

int FakeCount(void) { return count; }
int FakeLastCbSize(void) { return last_cb; }
int FakeExpectedSize(void) { return (int)sizeof(INPUT); }
void FakeReset(void) { count = 0; last_cb = 0; fail = 0; }
void FakeSetFail(int f) { fail = f; }
uint32_t FakeType(int i) { return rec[i].type; }
uint32_t FakeVk(int i) { return rec[i].ki.wVk; }
uint32_t FakeScan(int i) { return rec[i].ki.wScan; }
uint32_t FakeFlags(int i) { return rec[i].ki.dwFlags; }
