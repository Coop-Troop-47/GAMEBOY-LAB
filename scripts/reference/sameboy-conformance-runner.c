/*
 * Small, deterministic SameBoy adapter used by scripts/sameboy-matrix.mjs.
 *
 * This intentionally requires an explicit --model.  It is not part of the
 * browser build; compile it against a pinned SameBoy checkout when auditing
 * a result, for example:
 *   cc -DGB_INTERNAL -I/path/to/SameBoy/Core \
 *     scripts/reference/sameboy-conformance-runner.c \
     /path/to/SameBoy/build/libsameboy.a -lm -o sameboy-conformance-runner
 *
 * The executable reports a machine-readable single-line record.  The matrix
 * runner adds ROM/boot hashes and the suite commit around that record.
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

#define CGB_BOOT_ROM_LENGTH 0x900

static int result = 0;
static const char *requested_model_name = NULL;
static uint16_t result_pc = 0;
static uint16_t result_bc = 0;
static uint16_t result_de = 0;
static uint16_t result_hl = 0;

static const char *revision_name(GB_model_t model)
{
    switch (model) {
        case GB_MODEL_CGB_0: return "cgb0";
        case GB_MODEL_CGB_A: return "cgbA";
        case GB_MODEL_CGB_B: return "cgbB";
        case GB_MODEL_CGB_C: return "cgbC";
        case GB_MODEL_CGB_D: return "cgbD";
        case GB_MODEL_CGB_E: return "cgbE";
        default: return NULL;
    }
}

static void vblank(GB_gameboy_t *gb, GB_vblank_type_t type) { (void)gb; (void)type; }
static char *async_input(GB_gameboy_t *gb) { (void)gb; return NULL; }
static void log_message(GB_gameboy_t *gb, const char *message, GB_log_attributes_t attributes)
{
    (void)gb;
    (void)message;
    (void)attributes;
}
static uint32_t encode(GB_gameboy_t *gb, uint8_t r, uint8_t g, uint8_t b)
{
    (void)gb;
    return 0xff000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
}

static void execute(GB_gameboy_t *gb, uint16_t address, uint8_t opcode)
{
    if (opcode != 0x40 || result) return;
    /* The opcode is a marker; the result byte is the authoritative protocol. */
    /* The marker lives in bank-0 WRAM at $CFFE.  Do not call the public
       memory accessor here: that API intentionally updates the
       emulated data-bus/open-bus decay state, which would make a diagnostic
       callback alter the machine it is measuring. */
    uint8_t result_code = gb->ram[0x0FFE];
    if (result_code != 'P' && result_code != 'F') return;
    result_pc = address;
    result_bc = gb->bc;
    result_de = gb->de;
    result_hl = gb->hl;
    if (result_code == 'P' && result_bc == 0x0305 && result_de == 0x080d && result_hl == 0x1522) result = 1;
    else if (result_code == 'F' && result_bc == 0x4242 && result_de == 0x4242 && result_hl == 0x4242) result = -1;
    else result = -2;
}

static GB_model_t parse_model(const char *value)
{
    if (!strcmp(value, "cgb0")) return GB_MODEL_CGB_0;
    if (!strcmp(value, "cgbA")) return GB_MODEL_CGB_A;
    if (!strcmp(value, "cgbB")) return GB_MODEL_CGB_B;
    if (!strcmp(value, "cgbC")) return GB_MODEL_CGB_C;
    if (!strcmp(value, "cgbD")) return GB_MODEL_CGB_D;
    if (!strcmp(value, "cgbE")) return GB_MODEL_CGB_E;
    fprintf(stderr, "unknown --model '%s' (must be cgb0/cgbA/cgbB/cgbC/cgbD/cgbE)\n", value);
    exit(64);
}

static unsigned char *read_file(const char *path, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END) || (*length = (size_t)ftell(file)) == (size_t)-1 || fseek(file, 0, SEEK_SET)) {
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

int main(int argc, char **argv)
{
    const char *model = NULL;
    const char *boot_path = NULL;
    const char *rom_path = NULL;
    uint64_t base_budget = 80000000ULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--model") && i + 1 < argc) model = argv[++i];
        else if (!strcmp(argv[i], "--boot") && i + 1 < argc) boot_path = argv[++i];
        else if ((!strcmp(argv[i], "--base-cycles") || !strcmp(argv[i], "--cycles")) && i + 1 < argc) {
            /* The matrix's public budget is in 4.194304 MHz-equivalent
               T-cycles. SameBoy's internal counter is in 8 MHz units, so
               every base-clock cycle consumes two runner units. */
            base_budget = strtoull(argv[++i], NULL, 10);
        }
        else if (argv[i][0] == '-') {
            fprintf(stderr, "unknown or incomplete option '%s'\n", argv[i]);
            return 64;
        }
        else if (!rom_path) rom_path = argv[i];
        else {
            fprintf(stderr, "only one ROM may be provided\n");
            return 64;
        }
    }
    if (!model || !rom_path || base_budget == 0 || base_budget > UINT64_MAX / 2) {
        fprintf(stderr, "usage: %s --model cgb0|cgbA|cgbB|cgbC|cgbD|cgbE [--boot PATH] [--base-cycles N] ROM\n", argv[0]);
        return 64;
    }
    requested_model_name = model;
    size_t rom_length = 0;
    unsigned char *rom = read_file(rom_path, &rom_length);
    if (!rom) return 66;

    GB_gameboy_t gb;
    GB_model_t requested_model = parse_model(model);
    /* Match SameBoy's deterministic tester policy; power-on RAM is not a
       hidden source of per-run variation in a conformance result. */
    GB_random_set_enabled(false);
    GB_init(&gb, requested_model);
    const char *selected_revision = revision_name(gb.model);
    if (!selected_revision || strcmp(selected_revision, requested_model_name)) {
        fprintf(stderr, "reference core selected %s for requested %s\n",
                selected_revision ?: "unknown", requested_model_name);
        GB_free(&gb);
        free(rom);
        return 70;
    }
    if (boot_path) {
        size_t boot_length = 0;
        unsigned char *boot = read_file(boot_path, &boot_length);
        if (!boot) { free(rom); GB_free(&gb); return 66; }
        if (boot_length != CGB_BOOT_ROM_LENGTH) {
            fprintf(stderr, "CGB boot ROM must be exactly 0x900 bytes (received 0x%zx)\n", boot_length);
            free(boot);
            free(rom);
            GB_free(&gb);
            return 65;
        }
        GB_load_boot_rom_from_buffer(&gb, boot, boot_length);
        free(boot);
    }
    else {
        // SameBoy normally receives a boot-ROM callback from its frontend.
        // For an explicit no-boot run, start from the post-boot state rather
        // than executing an uninitialised zero-filled boot-ROM buffer.
        gb.boot_rom_finished = true;
    }
    /* Keep the reference adapter's core settings aligned with SameBoy's
       official Tester, rather than letting frontend defaults leak into a
       result. */
    /* SameBoy's Tester uses the historical EMULATE_HARDWARE alias.  In the
       current API that alias is exactly MODERN_BALANCED, so use the canonical
       non-deprecated spelling while preserving the same mode value. */
    GB_set_color_correction_mode(&gb, GB_COLOR_CORRECTION_MODERN_BALANCED);
    GB_set_rtc_mode(&gb, GB_RTC_MODE_ACCURATE);
    GB_set_emulate_joypad_bouncing(&gb, false);
    if (GB_load_rom(&gb, rom_path)) {
        fprintf(stderr, "failed to load ROM %s\n", rom_path);
        GB_free(&gb);
        free(rom);
        return 66;
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
    const char *status = result > 0 ? "pass" : result < 0 ? (result == -1 ? "fail" : "protocol-error") : "timeout";
    uint8_t result_code = GB_read_memory(&gb, 0xcffe);
    uint16_t terminal_pc = result ? result_pc : gb.pc;
    uint16_t terminal_bc = result ? result_bc : gb.bc;
    uint16_t terminal_de = result ? result_de : gb.de;
    uint16_t terminal_hl = result ? result_hl : gb.hl;
    uint8_t terminal_opcode = GB_read_memory(&gb, terminal_pc);
    printf("{\"result\":\"%s\",\"model\":\"cgb\",\"requestedRevision\":\"%s\",\"selectedRevision\":\"%s\",\"cycles\":\"%" PRIu64 "\",\"baseCycles\":\"%" PRIu64 "\",\"pc\":%u,\"bc\":%u,\"de\":%u,\"hl\":%u,\"opcode\":%u,\"resultCode\":%u,\"registers\":[%u,%u,%u,%u,%u,%u]}\n",
           status, requested_model_name, selected_revision, cycles, (cycles + 1) / 2, terminal_pc,
           terminal_bc, terminal_de, terminal_hl, terminal_opcode, result_code,
           terminal_bc >> 8, terminal_bc & 0xFF, terminal_de >> 8, terminal_de & 0xFF,
           terminal_hl >> 8, terminal_hl & 0xFF);
    GB_free(&gb);
    free(rom);
    return result > 0 ? 0 : result == -1 ? 1 : result == 0 ? 2 : 3;
}
