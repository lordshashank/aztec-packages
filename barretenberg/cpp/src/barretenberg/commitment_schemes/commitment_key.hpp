// === AUDIT STATUS ===
// internal:    { status: not started, auditors: [], date: YYYY-MM-DD }
// external_1:  { status: not started, auditors: [], date: YYYY-MM-DD }
// external_2:  { status: not started, auditors: [], date: YYYY-MM-DD }
// =====================

#pragma once

/**
 * @brief Provides interfaces for different 'CommitmentKey' classes.
 *
 * TODO(#218)(Mara): This class should handle any modification to the SRS (e.g compute pippenger point table) to
 * simplify the codebase.
 */

#include "barretenberg/common/bb_bench.hpp"
#include "barretenberg/common/ref_span.hpp"
#include "barretenberg/common/thread.hpp"
#include "barretenberg/constants.hpp"
#include "barretenberg/ecc/batched_affine_addition/batched_affine_addition.hpp"
#include "barretenberg/ecc/scalar_multiplication/scalar_multiplication.hpp"
#include "barretenberg/ecc/scalar_multiplication/scalar_multiplication_fast.hpp"
#include "barretenberg/numeric/bitop/get_msb.hpp"
#include "barretenberg/numeric/bitop/pow.hpp"
#include "barretenberg/polynomials/polynomial.hpp"
#include "barretenberg/polynomials/polynomial_arithmetic.hpp"
#include "barretenberg/srs/factories/crs_factory.hpp"
#include "barretenberg/srs/global_crs.hpp"

#include <cstddef>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string_view>

namespace bb {
/**
 * @brief CommitmentKey object over a pairing group 𝔾₁.
 *
 * @details Commitments are computed as C = [p(x)] = ∑ᵢ aᵢ⋅Gᵢ where Gᵢ is the i-th element of the SRS. For BN254,
 * the SRS is given as a list of 𝔾₁ points { [xʲ]₁ }ⱼ where 'x' is unknown. For Grumpkin, they are random points. The
 * SRS stored in the commitment key is after applying the pippenger_point_table thus being double the size of what is
 * loaded from path.
 */
template <class Curve> class CommitmentKey {

    using Fr = typename Curve::ScalarField;
    using Commitment = typename Curve::AffineElement;
    using G1 = typename Curve::AffineElement;

    /**
     * @brief Dispatch between the round-parallel Pippenger rewrite (backported from origin/next)
     * and the legacy implementation.
     *
     * Measured on this machine (arm64-darwin, DISABLE_ASM generic-int128 field arithmetic, frozen
     * 2^21 UltraHonk task): the rewrite wins isolated multithreaded MSMs (2^21 random at 8 threads:
     * 530ms legacy vs 512ms fast; wire-like with dedup 399ms vs 378ms) but is ~16-20% SLOWER
     * single-threaded at n >= 2^16 (2^21 random: 3.11s legacy vs 3.63s fast) — its round-parallel
     * pass structure only pays off when threads hide the extra schedule/scatter memory traffic.
     * Full-prove wall clock: HC=1 26.7s legacy vs 30.2s fast; HC=8 5.47s vs 5.67s; HC=14 5.02s vs
     * 5.37s (the fast path's larger working set competes with the rest of the prover).
     * (GLV-at-large-n and a bigger BATCH_MEM_BUDGET were also tried: both worse single-threaded.)
     * Default: legacy when single-threaded (the benchmark-critical case), the rewrite otherwise
     * (upstream-default parity; wins isolated MSMs). Env overrides for benchmarking:
     * BB_MSM_FAST=1 forces the rewrite, BB_MSM_LEGACY=1 forces legacy (both read once).
     */
    static bool use_legacy_msm()
    {
        static const bool use_legacy = [] {
            if (std::getenv("BB_MSM_FAST") != nullptr) {
                return false;
            }
            if (std::getenv("BB_MSM_LEGACY") != nullptr) {
                return true;
            }
            return get_num_cpus() <= 1;
        }();
        return use_legacy;
    }

    static size_t get_num_needed_srs_points(size_t num_points)
    {
        // NOTE: Currently we must round up internal space for points as our pippenger algorithm (specifically,
        // pippenger_unsafe_optimized_for_non_dyadic_polys) will use next power of 2. This is used to simplify the
        // recursive halving scheme. We do, however allow the polynomial to not be fully formed. Pippenger internally
        // will pad 0s into the runtime state.
        return numeric::round_up_power_2(num_points);
    }

  public:
    std::shared_ptr<srs::factories::Crs<Curve>> srs;
    size_t dyadic_size;

    CommitmentKey() = default;

    /**
     * @brief Construct a new Kate Commitment Key object from existing SRS
     *
     * @param n
     * @param path
     *
     */
    CommitmentKey(const size_t num_points)
        : srs(srs::get_crs_factory<Curve>()->get_crs(get_num_needed_srs_points(num_points)))
        , dyadic_size(get_num_needed_srs_points(num_points))
    {}
    /**
     * @brief Checks the commitment key is properly initialized.
     *
     * @return bool
     */
    bool initialized() const { return srs != nullptr; }

    /**
     * @brief Uses the ProverSRS to create a commitment to p(X)
     *
     * @param polynomial a univariate polynomial p(X) = ∑ᵢ aᵢ⋅Xⁱ
     * @return Commitment computed as C = [p(x)] = ∑ᵢ aᵢ⋅Gᵢ
     */
    Commitment commit(PolynomialSpan<const Fr> polynomial, bool has_duplicates_hint = false) const
    {
        // Note: this fn used to expand polynomials to the dyadic size,
        // due to a quirk in how our pippenger algo used to function.
        // The pippenger algo has been refactored and this is no longer an issue
        BB_BENCH_NAME("CommitmentKey::commit");
        std::span<const G1> point_table = srs->get_monomial_points();
        size_t consumed_srs = polynomial.start_index + polynomial.size();
        if (consumed_srs > srs->get_monomial_size()) {
            throw_or_abort(format("Attempting to commit to a polynomial that needs ",
                                  consumed_srs,
                                  " points with an SRS of size ",
                                  srs->get_monomial_size()));
        }

        // Route to the round-parallel Pippenger rewrite (backported from origin/next) by default;
        // legacy implementation behind env BB_MSM_LEGACY.
        G1 r = use_legacy_msm()
                   ? scalar_multiplication::pippenger_unsafe<Curve>(polynomial, point_table)
                   : scalar_multiplication::pippenger_unsafe_fast<Curve>(polynomial, point_table, has_duplicates_hint);
        Commitment point(r);
        return point;
    };
    /**
     * @brief Batch commitment to multiple polynomials
     * @details Uses batch_multi_scalar_mul for more efficient processing when committing to multiple polynomials.
     *          The input polynomials are not const because batch_mul modifies them and then restores them back.
     *
     * @param polynomials vector of polynomial spans to commit to
     * @return std::vector<Commitment> vector of commitments, one for each polynomial
     */
    std::vector<Commitment> batch_commit(RefSpan<Polynomial<Fr>> polynomials,
                                         size_t max_batch_size = std::numeric_limits<size_t>::max(),
                                         std::span<const uint8_t> has_duplicates_hints = {}) const
    {
        BB_BENCH_NAME("CommitmentKey::batch_commit");

        // We can only commit max_batch_size at a time
        // This is to prevent excessive memory usage in the pippenger algorithm
        // First batch, create the commitments vector
        std::vector<Commitment> commitments;

        for (size_t i = 0; i < polynomials.size();) {
            // Note: have to be careful how we compute this to not overlow e.g. max_batch_size + 1 would
            size_t batch_size = std::min(max_batch_size, polynomials.size() - i);
            size_t batch_end = i + batch_size;

            // Prepare spans for batch MSM. All polynomials in the batch share the SRS point set;
            // each scalar span carries its own start offset into it (PolynomialSpan::start_index).
            std::vector<PolynomialSpan<Fr>> scalar_spans;
            scalar_spans.reserve(batch_size);

            for (auto& polynomial : polynomials.subspan(i, batch_end - i)) {
                size_t consumed_srs = polynomial.start_index() + polynomial.size();
                if (consumed_srs > srs->get_monomial_size()) {
                    throw_or_abort(format("Attempting to commit to a polynomial that needs ",
                                          consumed_srs,
                                          " points with an SRS of size ",
                                          srs->get_monomial_size()));
                }
                scalar_spans.emplace_back(polynomial.start_index(), polynomial.coeffs());
            }

            // Per-polynomial dedup opt-ins for this chunk of the batch (if provided).
            std::span<const uint8_t> hints_chunk = {};
            if (has_duplicates_hints.size() == polynomials.size()) {
                hints_chunk = has_duplicates_hints.subspan(i, batch_end - i);
            }

            // Perform batch MSM: round-parallel Pippenger rewrite (backported from origin/next) by
            // default; legacy implementation behind env BB_MSM_LEGACY.
            if (!use_legacy_msm()) {
                auto results = scalar_multiplication::MSM_fast<Curve>::batch_multi_scalar_mul(
                    srs->get_monomial_points(), scalar_spans, /*handle_edge_cases=*/false, hints_chunk);
                for (const auto& result : results) {
                    commitments.emplace_back(result);
                }
            } else {
                std::vector<std::span<const G1>> points_spans;
                std::vector<std::span<Fr>> legacy_scalar_spans;
                points_spans.reserve(scalar_spans.size());
                legacy_scalar_spans.reserve(scalar_spans.size());
                for (auto& scalar_span : scalar_spans) {
                    points_spans.emplace_back(srs->get_monomial_points().subspan(scalar_span.start_index));
                    legacy_scalar_spans.emplace_back(scalar_span.span);
                }
                auto results =
                    scalar_multiplication::MSM<Curve>::batch_multi_scalar_mul(points_spans, legacy_scalar_spans, false);
                for (const auto& result : results) {
                    commitments.emplace_back(result);
                }
            }
            i += batch_size;
        }
        return commitments;
    };

    // helper builder struct for constructing a batch to commit at once
    struct CommitBatch {
        CommitmentKey* key;
        RefVector<Polynomial<Fr>> wires;
        std::vector<std::string> labels;
        std::vector<uint8_t> has_duplicates_hints; // per-poly dedup opt-in (parallel to wires)
        std::vector<Commitment> commit_and_send_to_verifier(auto transcript,
                                                            size_t max_batch_size = std::numeric_limits<size_t>::max())
        {
            std::vector<Commitment> commitments = key->batch_commit(wires, max_batch_size, has_duplicates_hints);
            for (size_t i = 0; i < commitments.size(); ++i) {
                transcript->send_to_verifier(labels[i], commitments[i]);
            }

            return commitments;
        }

        void add_to_batch(Polynomial<Fr>& poly, const std::string& label, bool mask, bool has_duplicates_hint = false)
        {
            if (mask) {
                poly.mask();
            }
            wires.push_back(poly);
            labels.push_back(label);
            has_duplicates_hints.push_back(has_duplicates_hint ? uint8_t{ 1 } : uint8_t{ 0 });
        }
    };

    CommitBatch start_batch() { return CommitBatch{ this, {}, {} }; }
};

} // namespace bb
