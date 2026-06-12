// === AUDIT STATUS ===
// internal:    { status: Completed, auditors: [Sergei], commit: }
// external_1:  { status: not started, auditors: [], commit: }
// external_2:  { status: not started, auditors: [], commit: }
// =====================

#include "prover_instance.hpp"
#include "barretenberg/common/assert.hpp"
#include "barretenberg/common/bb_bench.hpp"
#include "barretenberg/common/log.hpp"
#include "barretenberg/common/memory_profile.hpp"
#include "barretenberg/common/throw_or_abort.hpp"
#include "barretenberg/flavor/mega_avm_flavor.hpp"
#include "barretenberg/honk/composer/composer_lib.hpp"
#include "barretenberg/honk/composer/permutation_lib.hpp"
#include "barretenberg/honk/proof_system/logderivative_library.hpp"
#include "barretenberg/stdlib_circuit_builders/ultra_circuit_builder.hpp"
#include "barretenberg/trace_to_polynomials/trace_to_polynomials.hpp"

#if defined(__GLIBC__) && !defined(__wasm__)
#include <malloc.h>
#endif

namespace bb {

template <typename Flavor> ProverInstance_<Flavor>::ProverInstance_(Circuit& circuit, bool consume_circuit)
{
    BB_BENCH_NAME("ProverInstance(Circuit&)");
    vinfo("Constructing ProverInstance");

    if constexpr (IsMegaFlavor<Flavor>) {
        consume_circuit = false; // Mega requires builder data (databus, ecc op) throughout construction
    }
    consumed_circuit = consume_circuit;

    // Check pairing point tagging: either no pairing points were created,
    // or all pairing points have been aggregated into a single equivalence class
    BB_ASSERT(circuit.pairing_points_tagging.has_single_pairing_point_tag(),
              "Pairing points must all be aggregated together. Either no pairing points should be created, or "
              "all created pairing points must be aggregated into a single pairing point. Found "
                  << circuit.pairing_points_tagging.num_unique_pairing_points() << " different pairing points.");
    // Check pairing point tagging: check that the pairing points have been set to public
    BB_ASSERT(circuit.pairing_points_tagging.has_public_pairing_points() ||
                  !circuit.pairing_points_tagging.has_pairing_points(),
              "Pairing points must be set to public in the circuit before constructing the ProverInstance.");

    // ProverInstances can be constructed multiple times, hence, we check whether the circuit has been finalized
    {
        BB_BENCH_NAME("finalize_circuit");
        if (!circuit.circuit_finalized) {
            circuit.finalize_circuit();
        }
        if (consume_circuit) {
            // The circuit is finalized: the bookkeeping that exists only to support gate creation/finalization can
            // be released now, ahead of the large polynomial allocations below.
            circuit.rom_ram_logic = typename Circuit::RomRamLogic{};
            circuit.range_lists.clear();
            circuit.constant_variable_indices.clear();
            decltype(circuit.cached_partial_non_native_field_multiplications)().swap(
                circuit.cached_partial_non_native_field_multiplications);
        }
        // Compute block offsets before dyadic size so that compute_dyadic_size can account for the lookup table offset
        circuit.blocks.compute_offsets(TRACE_OFFSET);
        metadata.dyadic_size = compute_dyadic_size(circuit);

        // Find index of last non-trivial wire value in the trace
        for (auto& block : circuit.blocks.get()) {
            if (block.size() > 0) {
                final_active_wire_idx = block.trace_end() - 1;
            }
        }
    }

    // The polynomials are allocated in stages, interleaved with the population steps that consume the corresponding
    // circuit data: this way, when the circuit is consumed, the memory of circuit data that has already been
    // transferred into polynomials can be reused for subsequent allocations instead of growing the peak (the builder
    // and the full set of polynomials never coexist).
    {
        BB_BENCH_NAME("allocating polynomials");
        vinfo("allocating wire and selector polynomials...");

        populate_memory_records(circuit);
        if (consume_circuit) {
            // The memory records have been copied (with offsets) into this instance; the circuit's copies are no
            // longer needed.
            std::vector<uint32_t>().swap(circuit.memory_read_records);
            std::vector<uint32_t>().swap(circuit.memory_write_records);
        }

        allocate_wires();
        allocate_selectors(circuit);

        if constexpr (IsMegaFlavor<Flavor>) {
            allocate_ecc_op_polynomials(circuit);
        }
    }

    // Populate the wire and selector polynomials and compute the copy cycles; under consume_circuit this
    // progressively releases the circuit's gate data and witness values.
    vinfo("populating trace...");
    {
        CopyCycles copy_cycles =
            TraceToPolynomials<Flavor>::populate_wires_and_selectors(circuit, polynomials, consume_circuit);

        if (consume_circuit) {
            // The wide selectors (allocated over the whole active range because they span several gate
            // blocks) are typically zero outside the blocks that use them — e.g. a Poseidon2-heavy trace
            // leaves q_m entirely zero and q_c/q_r/q_o/q_4 mostly zero. Trim each to its
            // [first_nonzero, last_nonzero] support: reads outside the window hit the polynomial's
            // virtual zeros, so every consumer sees identical values while the dead backing is freed.
            {
                BB_BENCH_NAME("trim_wide_selector_supports");
                auto trim_to_support = [&](Polynomial& poly) {
                    const size_t start = poly.start_index();
                    const size_t end = poly.end_index();
                    size_t first_nonzero = end;
                    size_t last_nonzero = start;
                    for (size_t i = start; i < end; ++i) {
                        if (!poly[i].is_zero()) {
                            first_nonzero = std::min(first_nonzero, i);
                            last_nonzero = i;
                        }
                    }
                    if (first_nonzero == end) { // all zero: keep a minimal stub with full virtual size
                        poly = Polynomial(1, dyadic_size(), 0);
                        return;
                    }
                    const size_t support = last_nonzero + 1 - first_nonzero;
                    if (support + 4096 >= end - start) { // not worth a copy for a few pages
                        return;
                    }
                    Polynomial trimmed(support, dyadic_size(), first_nonzero);
                    for (size_t i = first_nonzero; i <= last_nonzero; ++i) {
                        trimmed.at(i) = poly[i];
                    }
                    poly = std::move(trimmed);
                };
                trim_to_support(polynomials.q_m);
                trim_to_support(polynomials.q_c);
                trim_to_support(polynomials.q_l);
                trim_to_support(polynomials.q_r);
                trim_to_support(polynomials.q_o);
                trim_to_support(polynomials.q_4);
            }
            // Compute the permutation argument on u32 sidecars first (sigma/id values are small signed
            // indices), so the copy-cycle and tag/tau data can be dropped BEFORE the ~8x larger Fr images
            // are materialized — the two never coexist, which keeps the PK-construction transient from
            // setting the process peak.
            {
                BB_BENCH_NAME("compute_permutation_argument_polynomials");
                compute_permutation_argument_sidecars<Flavor>(
                    circuit, sigma_id_sidecars, copy_cycles, NUM_ZERO_ROWS, trace_active_range_size());
            }
            circuit.release_permutation_data();
            copy_cycles = {};

#if defined(__GLIBC__) && !defined(__wasm__)
            // The consumed builder/cycle memory was freed in small chunks that glibc retains in the
            // arena, while the sigma/id materialization below allocates large blocks that go to fresh
            // mmaps — the retained pages and the new blocks would stack up in peak RSS. Return the
            // free arena pages to the OS before the climb.
            malloc_trim(0);
#endif

            allocate_permutation_argument_polynomials();
            {
                BB_BENCH_NAME("materialize_permutation_argument_polynomials");
                auto sigmas = polynomials.get_sigmas();
                auto ids = polynomials.get_ids();
                const size_t domain_size = trace_active_range_size() - NUM_ZERO_ROWS;
                const MultithreadData thread_data = calculate_thread_data(domain_size);
                for (size_t wire_idx = 0; wire_idx < sigmas.size(); ++wire_idx) {
                    auto& sigma = sigmas[wire_idx];
                    auto& id = ids[wire_idx];
                    const auto& sigma_sidecar = sigma_id_sidecars[wire_idx];
                    const auto& id_sidecar = sigma_id_sidecars[sigmas.size() + wire_idx];
                    parallel_for(thread_data.num_threads, [&](size_t j) {
                        for (size_t i = thread_data.start[j]; i < thread_data.end[j]; ++i) {
                            const size_t poly_idx = i + NUM_ZERO_ROWS;
                            sigma.at(poly_idx) = sigma_sidecar.template decompress<FF>(poly_idx);
                            id.at(poly_idx) = id_sidecar.template decompress<FF>(poly_idx);
                        }
                    });
                }
            }
        } else {
            // Allocate the permutation argument polynomials only now: under consume_circuit this reuses the
            // memory released by the circuit's gate data instead of growing the peak.
            allocate_permutation_argument_polynomials();

            // Compute the permutation argument polynomials (sigma/id) and add them to proving key
            {
                BB_BENCH_NAME("compute_permutation_argument_polynomials");

                compute_permutation_argument_polynomials<Flavor>(circuit, polynomials, copy_cycles);
            }
        }
    }

    {
        BB_BENCH_NAME("allocating table/lagrange polynomials");

        allocate_table_lookup_polynomials(circuit);
        allocate_lagrange_polynomials();
        if constexpr (HasDataBus<Flavor>) {
            allocate_databus_polynomials(circuit);
        }

        // Set the shifted polynomials now that all of the to_be_shifted polynomials are defined.
        polynomials.set_shifted();
    }

    if (detail::use_memory_profile) {
        detail::GLOBAL_MEMORY_PROFILE.add_checkpoint("after_alloc");
    }

    if constexpr (IsMegaFlavor<Flavor>) {
        BB_BENCH_NAME("constructing databus polynomials");
        construct_databus_polynomials(circuit);
    }

    // Set the lagrange polynomials (lagrange_first at first active row after disabled region)
    polynomials.lagrange_first.at(TRACE_OFFSET) = 1;
    polynomials.lagrange_last.at(final_active_wire_idx) = 1;

    construct_lookup_polynomials(circuit);
    if (consume_circuit) {
        // The lookup table polynomials and read counts/tags have been constructed; the tables are no longer needed.
        std::remove_reference_t<decltype(circuit.get_lookup_tables())>().swap(circuit.get_lookup_tables());
    }

    // Public inputs (the pub_inputs block's size/offset remain valid after gate data release: blocks cache their
    // size when freed)
    metadata.num_public_inputs = circuit.blocks.pub_inputs.size();
    metadata.pub_inputs_offset = circuit.blocks.pub_inputs.trace_offset();
    for (size_t i = 0; i < metadata.num_public_inputs; ++i) {
        size_t idx = i + metadata.pub_inputs_offset;
        public_inputs.emplace_back(polynomials.w_r[idx]);
    }

    // Copy IPA proof if present
    ipa_proof = circuit.ipa_proof;

    if (std::getenv("BB_POLY_STATS")) {
        analyze_prover_polynomials(polynomials);
    }
    if (detail::use_memory_profile) {
        detail::GLOBAL_MEMORY_PROFILE.add_checkpoint("after_trace");
    }
}

/**
 * @brief Compute the minimum dyadic (power-of-2) circuit size
 * @details The dyadic circuit size is the smallest power of two which can accommodate all polynomials required for the
 * proving system. This size must account for the execution trace itself, i.e. the wires/selectors, but also any
 * auxiliary polynomials like those that store the table data for lookup arguments.
 *
 * @tparam Flavor
 * @param circuit
 */
template <typename Flavor> size_t ProverInstance_<Flavor>::compute_dyadic_size(Circuit& circuit)
{
    // For the lookup argument the circuit size must be at least as large as the sum of all tables used
    const size_t tables_size = circuit.get_tables_size();

    // minimum size of execution trace due to everything else
    size_t min_size_of_execution_trace = circuit.blocks.get_total_content_size();

    // Tables are placed at the lookup block's trace offset, so account for blocks preceding lookup
    const size_t tables_end = circuit.blocks.lookup.trace_offset() + tables_size;
    const size_t trace_end = TRACE_OFFSET + NUM_ZERO_ROWS + min_size_of_execution_trace;
    size_t total_num_gates = std::max(tables_end, trace_end);

    // Next power of 2 (dyadic circuit size)
    return circuit.get_circuit_subgroup_size(total_num_gates);
}

template <typename Flavor> void ProverInstance_<Flavor>::allocate_wires()
{
    BB_BENCH_NAME("allocate_wires");

    const size_t wire_size = trace_active_range_size();

    for (auto& wire : polynomials.get_wires()) {
        wire = Polynomial::shiftable(wire_size, dyadic_size(), Flavor::HasZK);
    }
}

template <typename Flavor> void ProverInstance_<Flavor>::allocate_permutation_argument_polynomials()
{
    BB_BENCH_NAME("allocate_permutation_argument_polynomials");

    // Sigma and ID polynomials are zero outside the active trace range. Inside the active range,
    // compute_permutation_argument_polynomials writes every cell (identity init + cycle linkages),
    // so the backing memory can be left uninitialized.
    for (auto& sigma : polynomials.get_sigmas()) {
        sigma = Polynomial::shiftable(trace_active_range_size(), dyadic_size(), Polynomial::DontZeroMemory::FLAG);
    }
    for (auto& id : polynomials.get_ids()) {
        id = Polynomial::shiftable(trace_active_range_size(), dyadic_size(), Polynomial::DontZeroMemory::FLAG);
    }

    if (consumed_circuit) {
        // Defer the real z_perm allocation to the grand-product computation in oink (its first
        // write): the PK-construction climb is the process peak, and oink runs well below it, so
        // the deferral takes z_perm's 1.4KB/gate out of the high-water mark. A minimal unmasked
        // shiftable stub keeps set_shifted() and any virtual-zero reads valid in the meantime;
        // the real allocation in oink applies the ZK masking rows.
        polynomials.z_perm = Polynomial::shiftable(NUM_ZERO_ROWS + 1, dyadic_size(), /*masked=*/false);
    } else {
        polynomials.z_perm = Polynomial::shiftable(trace_active_range_size(), dyadic_size(), Flavor::HasZK);
    }
}

template <typename Flavor> void ProverInstance_<Flavor>::allocate_lagrange_polynomials()
{
    BB_BENCH_NAME("allocate_lagrange_polynomials");

    polynomials.lagrange_first = Polynomial(
        /* size=*/1, /*virtual size=*/dyadic_size(), /*start_index=*/TRACE_OFFSET);

    polynomials.lagrange_last = Polynomial(
        /* size=*/1, /*virtual size=*/dyadic_size(), /*start_index=*/final_active_wire_idx);
}

template <typename Flavor> void ProverInstance_<Flavor>::allocate_selectors(const Circuit& circuit)
{
    BB_BENCH_NAME("allocate_selectors");

    // Define gate selectors over the block they are isolated to
    for (auto [selector, block] : zip_view(polynomials.get_gate_selectors(), circuit.blocks.get_gate_blocks())) {
        selector = Polynomial(block.size(), dyadic_size(), block.trace_offset());
    }

    auto non_gate_selectors = polynomials.get_non_gate_selectors();
    if (!consumed_circuit) {
        // Set the other non-gate selector polynomials (e.g. q_l, q_r, q_m etc.) to active trace size
        for (auto& selector : non_gate_selectors) {
            selector = Polynomial(trace_active_range_size(), dyadic_size());
        }
        return;
    }

    // In one-shot proving the builder is consumed, so allocate wide selectors directly to their nonzero support.
    // Trace population writes through set_if_valid_index(), preserving virtual zeros outside each backed span.
    for (size_t selector_idx = 0; selector_idx < non_gate_selectors.size(); ++selector_idx) {
        size_t first_nonzero = trace_active_range_size();
        size_t last_nonzero = 0;
        for (const auto& block : circuit.blocks.get()) {
            const auto& source = block.non_gate_selectors[selector_idx];
            const size_t block_size = block.size();
            for (size_t row_idx = 0; row_idx < block_size; ++row_idx) {
                if (!source[row_idx].is_zero()) {
                    const size_t trace_idx = block.trace_offset() + row_idx;
                    first_nonzero = std::min(first_nonzero, trace_idx);
                    last_nonzero = trace_idx;
                }
            }
        }

        auto& selector = non_gate_selectors[selector_idx];
        if (first_nonzero == trace_active_range_size()) {
            selector = Polynomial(1, dyadic_size(), 0);
        } else {
            selector = Polynomial(last_nonzero + 1 - first_nonzero, dyadic_size(), first_nonzero);
        }
    }
}

template <typename Flavor> void ProverInstance_<Flavor>::allocate_table_lookup_polynomials(const Circuit& circuit)
{
    BB_BENCH_NAME("allocate_table_lookup_and_lookup_read_polynomials");

    const size_t tables_size = circuit.get_tables_size(); // cumulative size of all lookup tables
    const size_t table_offset = circuit.blocks.lookup.trace_offset();
    const size_t tables_end = table_offset + tables_size;

    // Tables start at the lookup block's trace offset, which is always past the disabled region
    BB_ASSERT_GTE(table_offset, TRACE_OFFSET);
    // Allocate polynomials containing the actual table data; offset to align with the lookup gate block
    BB_ASSERT_GTE(dyadic_size(), tables_end);
    for (auto& table_poly : polynomials.get_tables()) {
        table_poly = Polynomial(tables_end, dyadic_size());
    }

    // Read counts and tags: track which table entries have been read
    polynomials.lookup_read_counts = Polynomial(tables_end, dyadic_size());
    polynomials.lookup_read_tags = Polynomial(tables_end, dyadic_size());

    // Lookup inverses: used in the log-derivative lookup argument
    // Must cover both the lookup gate block (where reads occur) and the table data itself
    const size_t lookup_block_end = circuit.blocks.lookup.trace_end();
    const size_t lookup_inverses_end = std::max(lookup_block_end, tables_end);

    polynomials.lookup_inverses = Polynomial(lookup_inverses_end, dyadic_size());

    if constexpr (Flavor::HasZK) {
        polynomials.lookup_read_counts.add_masking();
        polynomials.lookup_read_tags.add_masking();
        polynomials.lookup_inverses.add_masking();
    }
}

template <typename Flavor>
void ProverInstance_<Flavor>::allocate_ecc_op_polynomials(const Circuit& circuit)
    requires IsMegaFlavor<Flavor>
{
    BB_BENCH_NAME("allocate_ecc_op_polynomials");

    // Allocate the ecc op wires and selector
    // Note: ECC op wires are not masked (they use random ops for ZK)
    const size_t ecc_op_end = circuit.blocks.ecc_op.trace_end();
    for (auto& wire : polynomials.get_ecc_op_wires()) {
        wire = Polynomial(ecc_op_end, dyadic_size());
    }
    polynomials.lagrange_ecc_op = Polynomial(ecc_op_end, dyadic_size());
}

template <typename Flavor>
void ProverInstance_<Flavor>::allocate_databus_polynomials(const Circuit& circuit)
    requires HasDataBus<Flavor>
{
    BB_BENCH_NAME("allocate_databus_and_lookup_inverse_polynomials");

    // Databus data uses NUM_DISABLED_ROWS_IN_SUMCHECK as its offset rather than Flavor::TRACE_OFFSET so that
    // commitments match across the IVC boundary (a non-ZK kernel's return_data is copy-constrained to a MegaZK
    // hiding kernel's kernel_calldata). MegaZK additionally requires this offset to clear the masking region
    // [1, NUM_DISABLED_ROWS_IN_SUMCHECK); non-ZK Mega mirrors the layout even though it has no masking.
    const auto offset_size = [](size_t content) -> size_t { return NUM_DISABLED_ROWS_IN_SUMCHECK + content; };

    // Databus inverses must cover both the databus gate block (where reads occur) and the data itself.
    const size_t q_busread_end = circuit.blocks.busread.trace_end();

    size_t max_databus_column_size = 0;

    bb::constexpr_for<0, NUM_BUS_COLUMNS, 1>([&]<size_t bus_idx>() {
        const size_t bus_size = circuit.get_bus_vector(bus_idx).size();
        max_databus_column_size = std::max(max_databus_column_size, bus_size);

        // Values + read_counts: sized to the bus data shifted by TRACE_OFFSET.
        auto entities = polynomials.template databus_entities_for_bus<bus_idx>();
        for (auto& entity : entities) {
            entity = Polynomial(offset_size(bus_size), dyadic_size());
        }

        // Inverse polynomial: sized to cover both the busread gate block and the shifted bus data.
        auto inverse_ref = polynomials.template databus_inverse_for_bus<bus_idx>();
        inverse_ref[0] = Polynomial(std::max(offset_size(bus_size), q_busread_end), dyadic_size());

        if constexpr (Flavor::HasZK) {
            // Mask databus witness polynomials. The kernel_calldata values column (bus_idx == 0) is NOT
            // masked; its read_counts column is.
            auto& values_poly = entities[0];
            auto& read_counts_poly = entities[1];
            if constexpr (bus_idx != 0) {
                values_poly.add_masking();
            }
            read_counts_poly.add_masking();
            inverse_ref[0].add_masking();
        }
    });

    polynomials.databus_id = Polynomial(offset_size(max_databus_column_size), dyadic_size());
}

template <typename Flavor> void ProverInstance_<Flavor>::construct_lookup_polynomials(Circuit& circuit)
{
    {
        BB_BENCH_NAME("constructing lookup table polynomials");
        construct_lookup_table_polynomials<Flavor>(polynomials.get_tables(), circuit);
    }
    {
        BB_BENCH_NAME("constructing lookup read counts");
        construct_lookup_read_counts<Flavor>(polynomials.lookup_read_counts, polynomials.lookup_read_tags, circuit);
    }
}

/**
 * @brief Populate the per-bus databus polynomials (values and read counts) and the identity polynomial.
 */
template <typename Flavor>
void ProverInstance_<Flavor>::construct_databus_polynomials(Circuit& circuit)
    requires HasDataBus<Flavor>
{
    // Databus offset of NUM_DISABLED_ROWS_IN_SUMCHECK is forced by cross-flavor commitment compatibility and
    // MegaZK masking; see allocate_databus_polynomials for the rationale.
    size_t max_bus_size = 0;
    bb::constexpr_for<0, NUM_BUS_COLUMNS, 1>([&]<size_t bus_idx>() {
        const auto& bus_vec = circuit.get_bus_vector(bus_idx);
        max_bus_size = std::max(max_bus_size, bus_vec.size());
        auto entities = polynomials.template databus_entities_for_bus<bus_idx>();
        auto& values_poly = entities[0];
        auto& read_counts_poly = entities[1];
        for (size_t idx = 0; idx < bus_vec.size(); ++idx) {
            values_poly.at(NUM_DISABLED_ROWS_IN_SUMCHECK + idx) = circuit.get_variable(bus_vec[idx]);
            read_counts_poly.at(NUM_DISABLED_ROWS_IN_SUMCHECK + idx) = bus_vec.get_read_count(idx);
        }
    });

    // Compute a simple identity polynomial for use in the databus lookup argument.
    auto& databus_id = polynomials.databus_id;
    for (size_t i = 0; i < max_bus_size; ++i) {
        databus_id.at(NUM_DISABLED_ROWS_IN_SUMCHECK + i) = i;
    }
}

/**
 * @brief Copy RAM/ROM record of reads and writes from the circuit to the instance.
 * @details The memory records in the circuit store indices within the memory block where a read/write is performed.
 * They are stored in the ProverInstance as indices into the full trace by accounting for the offset of the memory
 * block.
 */
template <typename Flavor> void ProverInstance_<Flavor>::populate_memory_records(const Circuit& circuit)
{
    // Store the read/write records as indices into the full trace by accounting for the offset of the memory block.
    uint32_t ram_rom_offset = circuit.blocks.memory.trace_offset();
    memory_read_records.reserve(circuit.memory_read_records.size());
    for (auto& index : circuit.memory_read_records) {
        memory_read_records.emplace_back(index + ram_rom_offset);
    }
    memory_write_records.reserve(circuit.memory_write_records.size());
    for (auto& index : circuit.memory_write_records) {
        memory_write_records.emplace_back(index + ram_rom_offset);
    }
}

template class ProverInstance_<UltraFlavor>;
template class ProverInstance_<UltraZKFlavor>;
template class ProverInstance_<UltraKeccakFlavor>;
#ifdef STARKNET_GARAGA_FLAVORS
template class ProverInstance_<UltraStarknetFlavor>;
template class ProverInstance_<UltraStarknetZKFlavor>;
#endif
template class ProverInstance_<UltraKeccakZKFlavor>;
template class ProverInstance_<MegaFlavor>;
template class ProverInstance_<MegaZKFlavor>;
template class ProverInstance_<MegaAvmFlavor>;

} // namespace bb
