// === AUDIT STATUS ===
// internal:    { status: not started, auditors: [], date: YYYY-MM-DD }
// external_1:  { status: not started, auditors: [], date: YYYY-MM-DD }
// external_2:  { status: not started, auditors: [], date: YYYY-MM-DD }
// =====================

#pragma once
#include "barretenberg/flavor/flavor.hpp"
#include "barretenberg/flavor/flavor_concepts.hpp"
#include "barretenberg/honk/composer/permutation_lib.hpp"
#include "barretenberg/srs/global_crs.hpp"

namespace bb {

template <class Flavor> class TraceToPolynomials {
    using Builder = typename Flavor::CircuitBuilder;
    using Polynomial = typename Flavor::Polynomial;
    using FF = typename Flavor::FF;
    using ExecutionTrace = typename Builder::ExecutionTrace;
    using Wires = std::array<std::vector<uint32_t>, Builder::NUM_WIRES>;
    using ProverPolynomials = typename Flavor::ProverPolynomials;

  public:
    static constexpr size_t NUM_WIRES = Builder::NUM_WIRES;

    /**
     * @brief Populate wire polynomials, selector polynomials (and, for Mega, ecc op wires) and compute the copy
     * cycles from raw circuit data. The wire and selector polynomials must already be allocated; the permutation
     * argument polynomials (sigma/id) need not exist yet (they are computed by the caller from the returned copy
     * cycles), which allows their allocation to be deferred until after the builder's gate data has been released.
     *
     * @param builder
     * @param consume_builder If true (Ultra flavors only), progressively release the builder's gate data
     * (block wire-index vectors and selectors) as soon as each block is transferred into the polynomials, and the
     * witness values and copy-constraint bookkeeping once all blocks are done. This substantially reduces peak
     * memory but leaves the builder unusable for anything except the permutation tag data (real_variable_tags/tau)
     * and the lookup tables, which remain valid. Ignored for Mega flavors (databus/ecc-op data is needed
     * downstream).
     * @return std::vector<CyclicPermutation> copy cycles describing the copy constraints in the circuit
     */
    static std::vector<CyclicPermutation> populate_wires_and_selectors(Builder& builder,
                                                                       ProverPolynomials&,
                                                                       bool consume_builder = false);

  private:
    /**
     * @brief Construct and add the goblin ecc op wires to the proving key
     * @details The ecc op wires vanish everywhere except on the ecc op block, where they contain a copy of the ecc op
     * data assumed already to be present in the corrresponding block of the conventional wires in the proving key.
     */
    static void add_ecc_op_wires_to_prover_instance(Builder& builder, ProverPolynomials&)
        requires IsMegaFlavor<Flavor>;
};

} // namespace bb
