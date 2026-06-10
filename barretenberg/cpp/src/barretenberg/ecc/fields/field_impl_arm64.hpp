// === AUDIT STATUS ===
// internal:    { status: not started, auditors: [], commit: }
// external_1:  { status: not started, auditors: [], commit: }
// external_2:  { status: not started, auditors: [], commit: }
// =====================

#pragma once

#include "./field_impl.hpp"

#if BBERG_ARM64_ASM

namespace bb {

/**
 * @brief Montgomery multiplication for Apple-silicon arm64 (4x64-bit limbs, "no-carry" CIOS).
 *
 * @details Implements the interleaved (no-carry) CIOS algorithm — the exact same algorithm as the
 * generic `montgomery_mul` — as hand-scheduled inline assembly. Valid only for moduli whose top
 * limb is < 2^62 (the dispatch in field_impl.hpp guarantees this). Operands follow the coarse
 * representation contract: inputs in [0, 2p) produce an output in [0, 2p), with NO final
 * conditional subtraction, exactly like the generic implementation. The result is bit-identical
 * to the generic implementation for all 256-bit inputs (including out-of-contract values): the
 * only place the generic code can drop a carry is the final `t3 = c + a` (a mod-2^64 wrap of
 * the 5th accumulator word), and the assembly below wraps the same word the same way.
 *
 * Scheduling notes (cf. gnark-crypto arm64 / EdMSM §6 "two-pass" trick): arm64 has a single flags
 * register, so each round separates the low-product carry chain from the high-product carry chain;
 * each chain then propagates as an uninterrupted adds/adcs/adc sequence. Two multiply-issue
 * savings vs a naive translation:
 *  - `k*p[0]`'s low half is never computed: t0 + lo(k*p0) == 0 (mod 2^64) by construction, so its
 *    carry-out is simply (t0 != 0), produced by `cmp t0, #1`.
 *  - `k = t0 * r_inv` is issued as soon as the new t0 is known, off the flags chains.
 */
template <class T> field<T> field<T>::asm_montgomery_mul_arm64(const field& a, const field& b) noexcept
{
    constexpr uint64_t r_inv = T::r_inv;
    constexpr uint64_t p0 = modulus.data[0];
    constexpr uint64_t p1 = modulus.data[1];
    constexpr uint64_t p2 = modulus.data[2];
    constexpr uint64_t p3 = modulus.data[3];

    uint64_t t0;
    uint64_t t1;
    uint64_t t2;
    uint64_t t3;
    uint64_t t4;
    uint64_t k;
    uint64_t q1;
    uint64_t q2;
    uint64_t q3;
    uint64_t u0;
    uint64_t u1;
    uint64_t u2;
    uint64_t u3;

    __asm__(
        /* ---- round 0: t = a0 * b ---- */
        "mul   %[t0], %[a0], %[b0]\n\t"
        "umulh %[t1], %[a0], %[b0]\n\t"
        "mul   %[q1], %[a0], %[b1]\n\t"
        "umulh %[t2], %[a0], %[b1]\n\t"
        "mul   %[k],  %[t0], %[ri]\n\t" /* k = t0 * r_inv (early: t0 is final) */
        "mul   %[q2], %[a0], %[b2]\n\t"
        "umulh %[t3], %[a0], %[b2]\n\t"
        "mul   %[q3], %[a0], %[b3]\n\t"
        "umulh %[t4], %[a0], %[b3]\n\t"
        "adds  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        /* reduce: t = (t + k * p) >> 64 */
        "mul   %[q1], %[k], %[p1]\n\t"
        "umulh %[u0], %[k], %[p0]\n\t"
        "mul   %[q2], %[k], %[p2]\n\t"
        "umulh %[u1], %[k], %[p1]\n\t"
        "mul   %[q3], %[k], %[p3]\n\t"
        "umulh %[u2], %[k], %[p2]\n\t"
        "umulh %[u3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t" /* carry = (t0 != 0) == carry-out of t0 + lo(k*p0) */
        "adcs  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[u0]\n\t"
        "adcs  %[t1], %[t2], %[u1]\n\t"
        "adcs  %[t2], %[t3], %[u2]\n\t"
        "adc   %[t3], %[t4], %[u3]\n\t"

        /* ---- round 1: t += a1 * b ---- */
        "mul   %[k],  %[a1], %[b0]\n\t"
        "mul   %[q1], %[a1], %[b1]\n\t"
        "mul   %[q2], %[a1], %[b2]\n\t"
        "mul   %[q3], %[a1], %[b3]\n\t"
        "umulh %[u0], %[a1], %[b0]\n\t"
        "umulh %[u1], %[a1], %[b1]\n\t"
        "umulh %[u2], %[a1], %[b2]\n\t"
        "umulh %[u3], %[a1], %[b3]\n\t"
        "adds  %[t0], %[t0], %[k]\n\t"
        "adcs  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], xzr, xzr\n\t"
        "mul   %[k], %[t0], %[ri]\n\t"
        "adds  %[t1], %[t1], %[u0]\n\t"
        "adcs  %[t2], %[t2], %[u1]\n\t"
        "adcs  %[t3], %[t3], %[u2]\n\t"
        "adc   %[t4], %[t4], %[u3]\n\t"
        "mul   %[q1], %[k], %[p1]\n\t"
        "umulh %[u0], %[k], %[p0]\n\t"
        "mul   %[q2], %[k], %[p2]\n\t"
        "umulh %[u1], %[k], %[p1]\n\t"
        "mul   %[q3], %[k], %[p3]\n\t"
        "umulh %[u2], %[k], %[p2]\n\t"
        "umulh %[u3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t"
        "adcs  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[u0]\n\t"
        "adcs  %[t1], %[t2], %[u1]\n\t"
        "adcs  %[t2], %[t3], %[u2]\n\t"
        "adc   %[t3], %[t4], %[u3]\n\t"

        /* ---- round 2: t += a2 * b ---- */
        "mul   %[k],  %[a2], %[b0]\n\t"
        "mul   %[q1], %[a2], %[b1]\n\t"
        "mul   %[q2], %[a2], %[b2]\n\t"
        "mul   %[q3], %[a2], %[b3]\n\t"
        "umulh %[u0], %[a2], %[b0]\n\t"
        "umulh %[u1], %[a2], %[b1]\n\t"
        "umulh %[u2], %[a2], %[b2]\n\t"
        "umulh %[u3], %[a2], %[b3]\n\t"
        "adds  %[t0], %[t0], %[k]\n\t"
        "adcs  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], xzr, xzr\n\t"
        "mul   %[k], %[t0], %[ri]\n\t"
        "adds  %[t1], %[t1], %[u0]\n\t"
        "adcs  %[t2], %[t2], %[u1]\n\t"
        "adcs  %[t3], %[t3], %[u2]\n\t"
        "adc   %[t4], %[t4], %[u3]\n\t"
        "mul   %[q1], %[k], %[p1]\n\t"
        "umulh %[u0], %[k], %[p0]\n\t"
        "mul   %[q2], %[k], %[p2]\n\t"
        "umulh %[u1], %[k], %[p1]\n\t"
        "mul   %[q3], %[k], %[p3]\n\t"
        "umulh %[u2], %[k], %[p2]\n\t"
        "umulh %[u3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t"
        "adcs  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[u0]\n\t"
        "adcs  %[t1], %[t2], %[u1]\n\t"
        "adcs  %[t2], %[t3], %[u2]\n\t"
        "adc   %[t3], %[t4], %[u3]\n\t"

        /* ---- round 3: t += a3 * b ---- */
        "mul   %[k],  %[a3], %[b0]\n\t"
        "mul   %[q1], %[a3], %[b1]\n\t"
        "mul   %[q2], %[a3], %[b2]\n\t"
        "mul   %[q3], %[a3], %[b3]\n\t"
        "umulh %[u0], %[a3], %[b0]\n\t"
        "umulh %[u1], %[a3], %[b1]\n\t"
        "umulh %[u2], %[a3], %[b2]\n\t"
        "umulh %[u3], %[a3], %[b3]\n\t"
        "adds  %[t0], %[t0], %[k]\n\t"
        "adcs  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], xzr, xzr\n\t"
        "mul   %[k], %[t0], %[ri]\n\t"
        "adds  %[t1], %[t1], %[u0]\n\t"
        "adcs  %[t2], %[t2], %[u1]\n\t"
        "adcs  %[t3], %[t3], %[u2]\n\t"
        "adc   %[t4], %[t4], %[u3]\n\t"
        "mul   %[q1], %[k], %[p1]\n\t"
        "umulh %[u0], %[k], %[p0]\n\t"
        "mul   %[q2], %[k], %[p2]\n\t"
        "umulh %[u1], %[k], %[p1]\n\t"
        "mul   %[q3], %[k], %[p3]\n\t"
        "umulh %[u2], %[k], %[p2]\n\t"
        "umulh %[u3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t"
        "adcs  %[t1], %[t1], %[q1]\n\t"
        "adcs  %[t2], %[t2], %[q2]\n\t"
        "adcs  %[t3], %[t3], %[q3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[u0]\n\t"
        "adcs  %[t1], %[t2], %[u1]\n\t"
        "adcs  %[t2], %[t3], %[u2]\n\t"
        "adc   %[t3], %[t4], %[u3]\n\t"
        : [t0] "=&r"(t0),
          [t1] "=&r"(t1),
          [t2] "=&r"(t2),
          [t3] "=&r"(t3),
          [t4] "=&r"(t4),
          [k] "=&r"(k),
          [q1] "=&r"(q1),
          [q2] "=&r"(q2),
          [q3] "=&r"(q3),
          [u0] "=&r"(u0),
          [u1] "=&r"(u1),
          [u2] "=&r"(u2),
          [u3] "=&r"(u3)
        : [a0] "r"(a.data[0]),
          [a1] "r"(a.data[1]),
          [a2] "r"(a.data[2]),
          [a3] "r"(a.data[3]),
          [b0] "r"(b.data[0]),
          [b1] "r"(b.data[1]),
          [b2] "r"(b.data[2]),
          [b3] "r"(b.data[3]),
          [p0] "r"(p0),
          [p1] "r"(p1),
          [p2] "r"(p2),
          [p3] "r"(p3),
          [ri] "r"(r_inv)
        : "cc");

    return { t0, t1, t2, t3 };
}

/**
 * @brief Montgomery squaring for Apple-silicon arm64 (4x64-bit limbs, "no-carry" CIOS).
 *
 * @details Mirrors the generic `montgomery_square` round structure exactly: round r adds
 * a_r^2 (at local word r) plus the doubled cross products 2*a_r*a_j (j > r) into the
 * accumulator, keeping the accumulator's value modulo 2^320 (the generic code's
 * `carry_hi` word — word 5 — is discarded between rounds; every mod-2^64 `adc` wrap below
 * lands on the same word), then performs one Montgomery reduction step. This makes the
 * routine bit-identical to the generic implementation for ALL inputs, including
 * out-of-contract values >= 2p where carry drops actually occur.
 * Saves 6 of the 16 a*b partial products vs asm_montgomery_mul_arm64.
 */
template <class T> field<T> field<T>::asm_montgomery_sqr_arm64(const field& a) noexcept
{
    constexpr uint64_t r_inv = T::r_inv;
    constexpr uint64_t p0 = modulus.data[0];
    constexpr uint64_t p1 = modulus.data[1];
    constexpr uint64_t p2 = modulus.data[2];
    constexpr uint64_t p3 = modulus.data[3];

    uint64_t t0;
    uint64_t t1;
    uint64_t t2;
    uint64_t t3;
    uint64_t t4;
    uint64_t k;
    uint64_t s0;
    uint64_t s1;
    uint64_t x1;
    uint64_t y1;
    uint64_t x2;
    uint64_t y2;
    uint64_t x3;
    uint64_t y3;

    __asm__(
        /* ---- round 0: t = a0^2 + 2*a0*(a1,a2,a3 << 64) ---- */
        "mul   %[t0], %[a0], %[a0]\n\t"
        "umulh %[s0], %[a0], %[a0]\n\t"
        "mul   %[k],  %[t0], %[ri]\n\t" /* k = t0 * r_inv (t0 is final) */
        "mul   %[x1], %[a1], %[a0]\n\t"
        "umulh %[y1], %[a1], %[a0]\n\t"
        "mul   %[x2], %[a2], %[a0]\n\t"
        "umulh %[y2], %[a2], %[a0]\n\t"
        "mul   %[x3], %[a3], %[a0]\n\t"
        "umulh %[y3], %[a3], %[a0]\n\t"
        /* cross row words 1..4 = (x1, y1+x2, y2+x3, y3+carry) */
        "adds  %[y1], %[y1], %[x2]\n\t"
        "adcs  %[y2], %[y2], %[x3]\n\t"
        "adc   %[y3], %[y3], xzr\n\t"
        /* double the row (mod 2^320: carry-out of word 4 is dropped); extr avoids flag ops */
        "extr  %[y3], %[y3], %[y2], #63\n\t"
        "extr  %[y2], %[y2], %[y1], #63\n\t"
        "extr  %[y1], %[y1], %[x1], #63\n\t"
        "lsl   %[x1], %[x1], #1\n\t"
        /* t1..t4 = doubled row + hi(a0^2) */
        "adds  %[t1], %[x1], %[s0]\n\t"
        "adcs  %[t2], %[y1], xzr\n\t"
        "adcs  %[t3], %[y2], xzr\n\t"
        "adc   %[t4], %[y3], xzr\n\t"
        /* reduce */
        "mul   %[x1], %[k], %[p1]\n\t"
        "umulh %[s0], %[k], %[p0]\n\t"
        "mul   %[x2], %[k], %[p2]\n\t"
        "umulh %[y1], %[k], %[p1]\n\t"
        "mul   %[x3], %[k], %[p3]\n\t"
        "umulh %[y2], %[k], %[p2]\n\t"
        "umulh %[y3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t"
        "adcs  %[t1], %[t1], %[x1]\n\t"
        "adcs  %[t2], %[t2], %[x2]\n\t"
        "adcs  %[t3], %[t3], %[x3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[s0]\n\t"
        "adcs  %[t1], %[t2], %[y1]\n\t"
        "adcs  %[t2], %[t3], %[y2]\n\t"
        "adc   %[t3], %[t4], %[y3]\n\t"

        /* ---- round 1: t += a1^2 << 64 + 2*a1*(a2,a3) << 128 ---- */
        "mul   %[s0], %[a1], %[a1]\n\t"
        "umulh %[s1], %[a1], %[a1]\n\t"
        "mul   %[x2], %[a2], %[a1]\n\t"
        "umulh %[y2], %[a2], %[a1]\n\t"
        "mul   %[x3], %[a3], %[a1]\n\t"
        "umulh %[y3], %[a3], %[a1]\n\t"
        "adds  %[y2], %[y2], %[x3]\n\t" /* word 3 */
        "adc   %[y3], %[y3], xzr\n\t"   /* word 4 */
        /* double words 2..4 (mod 2^320) without flag ops */
        "extr  %[y3], %[y3], %[y2], #63\n\t"
        "extr  %[y2], %[y2], %[x2], #63\n\t"
        "lsl   %[x2], %[x2], #1\n\t"
        "adds  %[t1], %[t1], %[s0]\n\t" /* square chain */
        "adcs  %[t2], %[t2], %[s1]\n\t"
        "adcs  %[t3], %[t3], xzr\n\t"
        "adc   %[t4], xzr, xzr\n\t"
        "mul   %[k], %[t0], %[ri]\n\t"
        "adds  %[t2], %[t2], %[x2]\n\t" /* doubled-row chain */
        "adcs  %[t3], %[t3], %[y2]\n\t"
        "adc   %[t4], %[t4], %[y3]\n\t"
        /* reduce */
        "mul   %[x1], %[k], %[p1]\n\t"
        "umulh %[s0], %[k], %[p0]\n\t"
        "mul   %[x2], %[k], %[p2]\n\t"
        "umulh %[y1], %[k], %[p1]\n\t"
        "mul   %[x3], %[k], %[p3]\n\t"
        "umulh %[y2], %[k], %[p2]\n\t"
        "umulh %[y3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t"
        "adcs  %[t1], %[t1], %[x1]\n\t"
        "adcs  %[t2], %[t2], %[x2]\n\t"
        "adcs  %[t3], %[t3], %[x3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[s0]\n\t"
        "adcs  %[t1], %[t2], %[y1]\n\t"
        "adcs  %[t2], %[t3], %[y2]\n\t"
        "adc   %[t3], %[t4], %[y3]\n\t"

        /* ---- round 2: t += a2^2 << 128 + 2*a2*a3 << 192 ---- */
        "mul   %[s0], %[a2], %[a2]\n\t"
        "umulh %[s1], %[a2], %[a2]\n\t"
        "mul   %[x3], %[a3], %[a2]\n\t"
        "umulh %[y3], %[a3], %[a2]\n\t"
        /* double words 3..4 (mod 2^320) without flag ops */
        "extr  %[y3], %[y3], %[x3], #63\n\t"
        "lsl   %[x3], %[x3], #1\n\t"
        "adds  %[t2], %[t2], %[s0]\n\t"
        "adcs  %[t3], %[t3], %[s1]\n\t"
        "adc   %[t4], xzr, xzr\n\t"
        "mul   %[k], %[t0], %[ri]\n\t"
        "adds  %[t3], %[t3], %[x3]\n\t"
        "adc   %[t4], %[t4], %[y3]\n\t"
        /* reduce */
        "mul   %[x1], %[k], %[p1]\n\t"
        "umulh %[s0], %[k], %[p0]\n\t"
        "mul   %[x2], %[k], %[p2]\n\t"
        "umulh %[y1], %[k], %[p1]\n\t"
        "mul   %[x3], %[k], %[p3]\n\t"
        "umulh %[y2], %[k], %[p2]\n\t"
        "umulh %[y3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t"
        "adcs  %[t1], %[t1], %[x1]\n\t"
        "adcs  %[t2], %[t2], %[x2]\n\t"
        "adcs  %[t3], %[t3], %[x3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[s0]\n\t"
        "adcs  %[t1], %[t2], %[y1]\n\t"
        "adcs  %[t2], %[t3], %[y2]\n\t"
        "adc   %[t3], %[t4], %[y3]\n\t"

        /* ---- round 3: t += a3^2 << 192 ---- */
        "mul   %[s0], %[a3], %[a3]\n\t"
        "umulh %[s1], %[a3], %[a3]\n\t"
        "adds  %[t3], %[t3], %[s0]\n\t"
        "adc   %[t4], %[s1], xzr\n\t"
        "mul   %[k], %[t0], %[ri]\n\t"
        /* reduce */
        "mul   %[x1], %[k], %[p1]\n\t"
        "umulh %[s0], %[k], %[p0]\n\t"
        "mul   %[x2], %[k], %[p2]\n\t"
        "umulh %[y1], %[k], %[p1]\n\t"
        "mul   %[x3], %[k], %[p3]\n\t"
        "umulh %[y2], %[k], %[p2]\n\t"
        "umulh %[y3], %[k], %[p3]\n\t"
        "cmp   %[t0], #1\n\t"
        "adcs  %[t1], %[t1], %[x1]\n\t"
        "adcs  %[t2], %[t2], %[x2]\n\t"
        "adcs  %[t3], %[t3], %[x3]\n\t"
        "adc   %[t4], %[t4], xzr\n\t"
        "adds  %[t0], %[t1], %[s0]\n\t"
        "adcs  %[t1], %[t2], %[y1]\n\t"
        "adcs  %[t2], %[t3], %[y2]\n\t"
        "adc   %[t3], %[t4], %[y3]\n\t"
        : [t0] "=&r"(t0),
          [t1] "=&r"(t1),
          [t2] "=&r"(t2),
          [t3] "=&r"(t3),
          [t4] "=&r"(t4),
          [k] "=&r"(k),
          [s0] "=&r"(s0),
          [s1] "=&r"(s1),
          [x1] "=&r"(x1),
          [y1] "=&r"(y1),
          [x2] "=&r"(x2),
          [y2] "=&r"(y2),
          [x3] "=&r"(x3),
          [y3] "=&r"(y3)
        : [a0] "r"(a.data[0]),
          [a1] "r"(a.data[1]),
          [a2] "r"(a.data[2]),
          [a3] "r"(a.data[3]),
          [p0] "r"(p0),
          [p1] "r"(p1),
          [p2] "r"(p2),
          [p3] "r"(p3),
          [ri] "r"(r_inv)
        : "cc");

    return { t0, t1, t2, t3 };
}

} // namespace bb

#endif // BBERG_ARM64_ASM
