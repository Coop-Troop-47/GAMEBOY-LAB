/*
 * Small, intentionally external Gambatte adapter used by the local
 * conformance harness. Gambatte exposes the CGB/DMG model choice, but not the
 * individual CGB silicon revisions that SameSuite names in its filenames.
 * The adapter therefore reports the requested revision separately from the
 * core's actual generic-CGB capability; the JavaScript harness must not turn
 * that into a revision-specific score.
 *
 * Build (against a local Gambatte-libretro checkout):
 *   c++ -O2 -std=c++17 -D__LIBRETRO__ \
 *     -I/path/to/gambatte/libgambatte/include \
 *     -I/path/to/gambatte/libgambatte/src \
 *     scripts/reference/gambatte-conformance-runner.cpp \
 *     /path/to/gambatte/gambatte_libretro.dylib \
 *     -Wl,-rpath,/path/to/gambatte -o gambatte-conformance-runner
 *
 * Usage:
 *   gambatte-conformance-runner --revision cgbE --boot PATH \
 *     --base-cycles 80000000 ROM
 */

#include <gambatte.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

std::vector<std::uint8_t> bootBytes;

bool bootGetter(void *, bool isCgb, std::uint8_t *destination, std::uint32_t capacity) {
    const std::size_t expected = isCgb ? 0x900u : 0x100u;
    if (bootBytes.size() != expected || capacity < expected) return false;
    std::memcpy(destination, bootBytes.data(), expected);
    return true;
}

bool readFile(const char *path, std::vector<std::uint8_t> &out) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    file.seekg(0, std::ios::end);
    const auto size = file.tellg();
    if (size <= 0) return false;
    file.seekg(0, std::ios::beg);
    out.resize(static_cast<std::size_t>(size));
    return static_cast<bool>(file.read(reinterpret_cast<char *>(out.data()), size));
}

void printJsonString(const std::string &value) {
    std::putchar('"');
    for (const char character : value) {
        if (character == '\\' || character == '"') std::printf("\\%c", character);
        else if (character >= 0x20) std::putchar(character);
    }
    std::putchar('"');
}

void printResult(const char *result, const char *revision, const char *selected,
                 std::uint64_t cycles, std::uint64_t baseCycles,
                 std::uint8_t resultCode) {
    std::printf("{\"result\":");
    printJsonString(result);
    std::printf(",\"model\":\"cgb\",\"requestedRevision\":");
    printJsonString(revision);
    std::printf(",\"selectedRevision\":");
    printJsonString(selected);
    std::printf(",\"cycles\":%llu,\"baseCycles\":%llu,\"pc\":%u,\"bc\":%u,\"de\":%u,\"hl\":%u,\"opcode\":%u,\"resultCode\":%u,\"registers\":[%u,%u,%u,%u,%u,%u]}\n",
        static_cast<unsigned long long>(cycles),
        static_cast<unsigned long long>(baseCycles),
        0, 0, 0, 0, 0, resultCode,
        0, 0, 0, 0, 0, 0);
}

} // namespace

int main(int argc, char **argv) {
    const char *revision = nullptr;
    const char *bootPath = nullptr;
    const char *romPath = nullptr;
    std::uint64_t cycleBudget = 80'000'000;

    for (int index = 1; index < argc; ++index) {
        if (std::strcmp(argv[index], "--revision") == 0 && index + 1 < argc) revision = argv[++index];
        else if (std::strcmp(argv[index], "--boot") == 0 && index + 1 < argc) bootPath = argv[++index];
        else if (std::strcmp(argv[index], "--base-cycles") == 0 && index + 1 < argc) cycleBudget = std::strtoull(argv[++index], nullptr, 10);
        else if (argv[index][0] != '-') romPath = argv[index];
        else return 2;
    }
    if (!revision || !romPath) return 2;
    if (bootPath && !readFile(bootPath, bootBytes)) return 3;
    if (bootPath && bootBytes.size() != 0x900) return 4;

    std::vector<std::uint8_t> rom;
    if (!readFile(romPath, rom)) return 5;

    gambatte::GB gameboy;
    if (bootPath) gameboy.setBootloaderGetter(bootGetter);
    if (gameboy.load(rom.data(), static_cast<unsigned>(rom.size()), gambatte::GB::FORCE_CGB) != 0) return 6;

    std::vector<gambatte::video_pixel_t> pixels(160 * 144);
    std::vector<gambatte::uint_least32_t> samples(37'200 * 2);
    std::uint64_t elapsed = 0;
    std::uint8_t resultCode = 0;
    bool observedResult = false;

    while (elapsed < cycleBudget) {
        unsigned sampleCount = 35'112;
        gameboy.runFor(pixels.data(), 160, samples.data(), samples.size(), sampleCount);
        elapsed += 70'224;
        const auto *wram = static_cast<const std::uint8_t *>(gameboy.rambank0_ptr());
        resultCode = wram[0x0FFE]; // $CFFE, SameSuite's result byte.
        if (resultCode == 0x50 || resultCode == 0x46) {
            observedResult = true;
            // Gambatte's public API does not expose CPU registers at the
            // SameSuite marker. Keep this as an explicit diagnostic result;
            // the strict harness must not treat it as a comparable pass.
            if (resultCode == 0x50 || resultCode == 0x46) {
                printResult(resultCode == 0x50 ? "pass" : "fail", revision, "generic-cgb",
                    elapsed, elapsed, resultCode);
                return resultCode == 0x50 ? 0 : 1;
            }
            printResult("protocol-error", revision, "generic-cgb", elapsed, elapsed, resultCode);
            return 3;
        }
    }

    printResult(observedResult ? "protocol-error" : "timeout", revision, "generic-cgb",
        elapsed, elapsed, resultCode);
    return observedResult ? 3 : 2;
}
