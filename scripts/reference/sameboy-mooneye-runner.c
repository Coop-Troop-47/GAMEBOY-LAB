/*
 * SameBoy adapter for the Mooneye acceptance protocol.
 *
 * This is deliberately separate from the SameSuite adapter: Mooneye marks a
 * result by stopping on opcode $40 with the Fibonacci register signature,
 * rather than writing SameSuite's $CFFE byte. The runner accepts an explicit
 * model and boot image so a reference run cannot silently change hardware.
 * Build it against the pinned SameBoy source used for the release audit.
 */
#define GB_INTERNAL
#include "gb.h"
#include "memory.h"
#include "random.h"
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int result = 0;
static uint16_t result_pc = 0;
static uint16_t result_bc = 0;
static uint16_t result_de = 0;
static uint16_t result_hl = 0;

static void vblank(GB_gameboy_t *gb, GB_vblank_type_t type) { (void)gb; (void)type; }
static char *async_input(GB_gameboy_t *gb) { (void)gb; return NULL; }
static void log_message(GB_gameboy_t *gb, const char *message, GB_log_attributes_t attributes)
{
    (void)gb; (void)message; (void)attributes;
}
static uint32_t encode(GB_gameboy_t *gb, uint8_t r, uint8_t g, uint8_t b)
{
    (void)gb;
    return 0xff000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
}

static void execute(GB_gameboy_t *gb, uint16_t address, uint8_t opcode)
{
    if (opcode != 0x40 || result) return;
    result_pc = address;
    result_bc = gb->bc;
    result_de = gb->de;
    result_hl = gb->hl;
    const bool pass = gb->b == 3 && gb->c == 5 && gb->d == 8
        && gb->e == 13 && gb->h == 21 && gb->l == 34;
    const bool fail = gb->b == 0x42 && gb->c == 0x42 && gb->d == 0x42
        && gb->e == 0x42 && gb->h == 0x42 && gb->l == 0x42;
    result = pass ? 1 : fail ? -1 : -2;
}

static unsigned char *read_file(const char *path, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END) || (*length = (size_t)ftell(file)) == (size_t)-1
        || fseek(file, 0, SEEK_SET)) {
        fclose(file);
        return NULL;
    }
    unsigned char *bytes = malloc(*length ? *length : 1);
    if (!bytes || fread(bytes, 1, *length, file) != *length) {
        free(bytes);
        bytes = NULL;
    }
    fclose(file);
    return bytes;
}

static GB_model_t parse_model(const char *value, const char **selected)
{
    if (!strcmp(value, "dmg")) { *selected = "dmgB"; return GB_MODEL_DMG_B; }
    if (!strcmp(value, "mgb")) { *selected = "mgb"; return GB_MODEL_MGB; }
    if (!strcmp(value, "cgb")) { *selected = "cgbE"; return GB_MODEL_CGB_E; }
    fprintf(stderr, "unknown --model '%s' (must be dmg, mgb, or cgb)\n", value);
    exit(64);
}

int main(int argc, char **argv)
{
    const char *model_name = NULL;
    const char *boot_path = NULL;
    const char *rom_path = NULL;
    uint64_t base_budget = 80000000ULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--model") && i + 1 < argc) model_name = argv[++i];
        else if (!strcmp(argv[i], "--boot") && i + 1 < argc) boot_path = argv[++i];
        else if ((!strcmp(argv[i], "--base-cycles") || !strcmp(argv[i], "--cycles")) && i + 1 < argc)
            base_budget = strtoull(argv[++i], NULL, 10);
        else if (argv[i][0] == '-') {
            fprintf(stderr, "unknown or incomplete option '%s'\n", argv[i]);
            return 64;
        }
        else if (!rom_path) rom_path = argv[i];
        else return 64;
    }
    if (!model_name || !rom_path || !base_budget || base_budget > UINT64_MAX / 2) return 64;

    size_t rom_length = 0;
    unsigned char *rom = read_file(rom_path, &rom_length);
    if (!rom) return 66;

    const char *selected_revision = NULL;
    GB_model_t model = parse_model(model_name, &selected_revision);
    GB_gameboy_t gb;
    GB_random_set_enabled(false);
    GB_init(&gb, model);
    if (boot_path) {
        size_t boot_length = 0;
        unsigned char *boot = read_file(boot_path, &boot_length);
        const size_t expected = model == GB_MODEL_CGB_E ? 0x900 : 0x100;
        if (!boot || boot_length != expected) {
            free(boot); free(rom); GB_free(&gb); return 65;
        }
        GB_load_boot_rom_from_buffer(&gb, boot, boot_length);
        free(boot);
    }
    else gb.boot_rom_finished = true;
    GB_set_color_correction_mode(&gb, GB_COLOR_CORRECTION_MODERN_BALANCED);
    GB_set_rtc_mode(&gb, GB_RTC_MODE_ACCURATE);
    GB_set_emulate_joypad_bouncing(&gb, false);
    if (GB_load_rom(&gb, rom_path)) {
        free(rom); GB_free(&gb); return 66;
    }
    uint32_t pixels[160 * 144] = {0};
    GB_set_pixels_output(&gb, pixels);
    GB_set_vblank_callback(&gb, vblank);
    GB_set_async_input_callback(&gb, async_input);
    GB_set_log_callback(&gb, log_message);
    GB_set_rgb_encode_callback(&gb, encode);
    GB_set_execution_callback(&gb, execute);
    GB_set_turbo_mode(&gb, true, true);
    gb.disable_rendering = true;

    const uint64_t budget = base_budget * 2;
    uint64_t cycles = 0;
    while (!result && cycles < budget) cycles += GB_run(&gb);
    const char *status = result > 0 ? "pass" : result < 0
        ? (result == -1 ? "fail" : "protocol-error") : "timeout";
    const uint16_t terminal_pc = result ? result_pc : gb.pc;
    const uint16_t terminal_bc = result ? result_bc : gb.bc;
    const uint16_t terminal_de = result ? result_de : gb.de;
    const uint16_t terminal_hl = result ? result_hl : gb.hl;
    printf("{\"result\":\"%s\",\"model\":\"%s\",\"selectedRevision\":\"%s\",\"cycles\":\"%" PRIu64 "\",\"baseCycles\":\"%" PRIu64 "\",\"pc\":%u,\"bc\":%u,\"de\":%u,\"hl\":%u,\"opcode\":%u,\"registers\":[%u,%u,%u,%u,%u,%u]}\n",
        status, model_name, selected_revision, cycles, (cycles + 1) / 2,
        terminal_pc, terminal_bc, terminal_de, terminal_hl,
        GB_read_memory(&gb, terminal_pc), terminal_bc >> 8, terminal_bc & 0xff,
        terminal_de >> 8, terminal_de & 0xff, terminal_hl >> 8, terminal_hl & 0xff);
    GB_free(&gb);
    free(rom);
    return result > 0 ? 0 : result == -1 ? 1 : result == 0 ? 2 : 3;
}
