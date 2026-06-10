#pragma once
// Lightweight current-RSS checkpoint logging (verbose-mode only).
// logstr() (used by info/vinfo) appends *peak* RSS, which is monotonic; for
// memory optimization work we also want the *current* RSS at a checkpoint.
#include "barretenberg/common/log.hpp"
#include <cstddef>

#if defined(__APPLE__)
#include <mach/mach.h>
#elif defined(__linux__)
#include <cstdio>
#include <unistd.h>
#endif

namespace bb {

inline size_t get_current_rss_bytes()
{
#if defined(__APPLE__)
    mach_task_basic_info_data_t info_data;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, reinterpret_cast<task_info_t>(&info_data), &count) ==
        KERN_SUCCESS) {
        return static_cast<size_t>(info_data.resident_size);
    }
    return 0;
#elif defined(__linux__)
    FILE* f = std::fopen("/proc/self/statm", "r");
    if (f == nullptr) {
        return 0;
    }
    long total = 0;
    long resident = 0;
    int matched = std::fscanf(f, "%ld %ld", &total, &resident);
    std::fclose(f);
    if (matched != 2) {
        return 0;
    }
    return static_cast<size_t>(resident) * static_cast<size_t>(sysconf(_SC_PAGESIZE));
#else
    return 0;
#endif
}

// Prints "MEMCP <label> cur: <current rss MiB>" via vinfo (which appends peak rss).
// Only active with verbose logging, so graded runs are unaffected.
inline void mem_cp(const char* label)
{
    const size_t bytes = get_current_rss_bytes();
    const size_t mib_x100 = (bytes * 100) / (1024 * 1024);
    vinfo("MEMCP ", label, " cur: ", mib_x100 / 100, ".", mib_x100 % 100, " MiB");
}

} // namespace bb
