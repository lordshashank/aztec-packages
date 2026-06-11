#pragma once
#include "barretenberg/common/assert.hpp"
#include "barretenberg/numeric/uint256/uint256.hpp"

#include <cstdint>
#include <vector>

namespace bb {

/**
 * @brief Compact u32 image of a permutation-argument polynomial (sigma/id).
 *
 * @details Every value of those polynomials is FF(k) or -FF(k) for a small index k < 2^31:
 * rows and wires are separated by PERMUTATION_ARGUMENT_VALUE_SEPARATOR = 2^28 (so identity and
 * cycle-linkage values are below 4*2^28), tag values sit at 4*2^28 + tau (tau is a small tag id),
 * and the public-input override on sigma_0 stores small *negated* indices. A sign bit plus 31 bits
 * of magnitude therefore loses nothing: 4 bytes/element instead of 32. This lets a one-shot prover
 * drop the Fr originals (~48 MiB each at 2^21) once sumcheck's first round has folded them into
 * the partial-evaluation table, keeping only the sidecar to re-derive their contribution to the
 * Gemini batched polynomial.
 */
struct CompressedIndexPolynomial {
    static constexpr uint32_t SIGN_BIT = uint32_t{ 1 } << 31;

    size_t start_index = 0;
    std::vector<uint32_t> values;

    size_t end_index() const { return start_index + values.size(); }

    /** @brief Reconstruct the field value at absolute index i (must lie in [start_index, end_index)). */
    template <typename FF> FF decompress(size_t i) const
    {
        const uint32_t packed = values[i - start_index];
        FF v(static_cast<uint64_t>(packed & ~SIGN_BIT));
        return (packed & SIGN_BIT) != 0 ? -v : v;
    }

    /**
     * @brief Build the u32 image of a sigma/id polynomial. Asserts (debug) that every value round-trips,
     * i.e. is +/-FF(k) with k < 2^31 — guaranteed by the permutation argument's value encoding.
     */
    template <typename Polynomial> static CompressedIndexPolynomial compress(const Polynomial& poly)
    {
        using FF = std::decay_t<decltype(poly[0])>;
        static const uint256_t modulus = FF::modulus;
        static const uint256_t half_modulus = modulus >> 1;

        CompressedIndexPolynomial out;
        out.start_index = poly.start_index();
        out.values.resize(poly.end_index() - poly.start_index());
        for (size_t i = poly.start_index(); i < poly.end_index(); ++i) {
            const uint256_t canonical(poly[i]);
            uint32_t packed = 0;
            if (canonical > half_modulus) {
                const uint256_t magnitude = modulus - canonical;
                BB_ASSERT_LT(magnitude, uint256_t(SIGN_BIT));
                packed = static_cast<uint32_t>(magnitude.data[0]) | SIGN_BIT;
            } else {
                BB_ASSERT_LT(canonical, uint256_t(SIGN_BIT));
                packed = static_cast<uint32_t>(canonical.data[0]);
            }
            out.values[i - out.start_index] = packed;
            BB_ASSERT_DEBUG(out.template decompress<FF>(i) == poly[i]);
        }
        return out;
    }
};

} // namespace bb
